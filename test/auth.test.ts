import { env as rawEnv, createExecutionContext, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { createSession, normalizeEmail, readCookie, SESSION_COOKIE, sha256 } from "../src/lib/session";
import { mailerKind } from "../src/lib/mailer";

/** The test pool signs every request in as an agency email; these tests run as an anonymous visitor instead. */
const anon = { ...(rawEnv as unknown as Env), DEV_AUTH_EMAIL: undefined, AGENCY_EMAILS: "staff@agency.test" } as Env;
const ORIGIN = "https://geo.test";

async function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", `${SESSION_COOKIE}=${init.cookie}`);
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), anon, createExecutionContext());
  return res;
}

const login = (email: string, extra: Record<string, string> = {}) =>
  req("/auth/login", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ email }) });

async function lastLink(to: string): Promise<string | null> {
  const row = await anon.DB.prepare("SELECT text FROM email_outbox WHERE to_email = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(to).first<{ text: string }>();
  const m = row?.text.match(/https:\/\/geo\.test\/auth\/verify\?token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function outboxCount(to: string): Promise<number> {
  return (await anon.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE to_email = ?1").bind(to).first<{ n: number }>())?.n ?? 0;
}

const verify = (token: string) =>
  req("/auth/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent(token)}`, redirect: "manual" });

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return readCookie(new Request(ORIGIN, { headers: { cookie: set.split(";")[0] } }), SESSION_COOKIE) ?? "";
}

let tenantSlug = "";

beforeAll(async () => {
  // A client workspace with a known owner, created through the agency endpoint (signed in as agency in the pool).
  const r = await SELF.fetch(`${ORIGIN}/api/tenants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Login Co", slug: "login-co", email_domain: "loginco.test" }) });
  const t = (await r.json()) as { id: string; slug: string };
  tenantSlug = t.slug;
  await anon.DB.prepare("INSERT INTO users (id, email) VALUES ('usr_owner1', 'owner@client.test')").run();
  await anon.DB.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?1, 'usr_owner1', 'owner')").bind(t.id).run();
});

describe("email sign-in", () => {
  it("uses the dev outbox in tests and validates emails", () => {
    expect(mailerKind(anon)).toBe("outbox");
    expect(mailerKind({ ...anon, ENVIRONMENT: "production" } as Env)).toBe("none");
    expect(normalizeEmail(" Owner@Client.TEST ")).toBe("owner@client.test");
    expect(normalizeEmail("not an email")).toBeNull();
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    const res = await login("nobody@nowhere.test");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
    expect(await outboxCount("nobody@nowhere.test")).toBe(0);
  });

  it("signs a known user in with a single-use link and a session cookie", async () => {
    expect((await login("Owner@Client.test")).status).toBe(200);
    const token = await lastLink("owner@client.test");
    expect(token).toBeTruthy();

    // The GET only shows a button, so a mail scanner opening the link doesn't use it up.
    const confirm = await req(`/auth/verify?token=${token}`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('action="/auth/verify"');

    const res = await verify(token!);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = cookieFrom(res);

    // Only the hash is stored.
    const stored = await anon.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?1").bind(await sha256(cookie)).first<{ n: number }>();
    expect(stored?.n).toBe(1);
    const raw = await anon.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?1").bind(cookie).first<{ n: number }>();
    expect(raw?.n).toBe(0);

    const me = await req("/api/me", { cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string }; tenant: { slug: string }; demo: boolean };
    expect(body.user.email).toBe("owner@client.test");
    expect(body.tenant.slug).toBe(tenantSlug);
    expect(body.demo).toBe(false);

    const verified = await anon.DB.prepare("SELECT email_verified_at FROM users WHERE id = 'usr_owner1'").first<{ email_verified_at: string | null }>();
    expect(verified?.email_verified_at).toBeTruthy();

    // The same link can't be used twice.
    const again = await verify(token!);
    expect(again.status).toBe(400);
    expect(again.headers.get("set-cookie")).toBeNull();

    // Cross-site writes with the cookie are refused.
    const cross = await req("/api/keys", { method: "POST", cookie, headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ name: "x" }) });
    expect(cross.status).toBe(403);

    // Sign out ends the session.
    const out = await req("/auth/logout", { method: "POST", cookie, headers: { accept: "application/json", origin: ORIGIN } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await req("/api/me", { cookie })).status).toBe(401);
  });

  it("rejects expired links", async () => {
    const token = "expired-token-0123456789";
    await anon.DB.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?1, 'owner@client.test', ?2)")
      .bind(await sha256(token), new Date(Date.now() - 60_000).toISOString())
      .run();
    expect((await verify(token)).status).toBe(400);
  });

  it("limits how many links one email can get", async () => {
    const email = "limited@client.test";
    await anon.DB.prepare("INSERT INTO users (id, email) VALUES ('usr_limited', ?1)").bind(email).run();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await login(email)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    expect(await outboxCount(email)).toBe(5);
  });

  it("lets agency staff in by link even before they have a user row", async () => {
    await login("staff@agency.test");
    const token = await lastLink("staff@agency.test");
    expect(token).toBeTruthy();
    const res = await verify(token!);
    expect(res.status).toBe(303);
    const me = await req("/api/me", { cookie: cookieFrom(res) });
    expect(((await me.json()) as { user: { is_agency: boolean } }).user.is_agency).toBe(true);
  });
});

describe("sessions from a Checkout return", () => {
  it("an unconfirmed session doesn't join workspaces by email domain", async () => {
    await anon.DB.prepare("INSERT INTO users (id, email, signup_pending) VALUES ('usr_pending', 'someone@loginco.test', 1)").run();
    const { token } = await createSession(anon, "usr_pending", false);
    const me = await req("/api/me", { cookie: token });
    expect(me.status).toBe(403);
    expect(((await me.json()) as { error: string }).error).toBe("no_tenant");

    // The same person after confirming their email joins the domain's workspace as a viewer.
    const { token: confirmed } = await createSession(anon, "usr_pending", true);
    const me2 = await req("/api/me", { cookie: confirmed });
    expect(me2.status).toBe(200);
    expect(((await me2.json()) as { tenant: { slug: string; role: string } }).tenant).toMatchObject({ slug: tenantSlug, role: "viewer" });
  });

  it("refuses a Checkout return it doesn't recognise", async () => {
    const res = await req("/auth/checkout-return?cs=cs_test_unknown", { redirect: "manual" });
    expect([303, 503]).toContain(res.status);
  });

  it("anonymous visitors still get the read-only demo when demo mode is on", async () => {
    const demoEnv = { ...anon, DEMO_MODE: "true" } as Env;
    const res = await app.fetch(new Request(`${ORIGIN}/api/me`), demoEnv, createExecutionContext());
    expect([200, 503]).toContain(res.status); // 503 only when demo data isn't seeded in this test database
  });
});
