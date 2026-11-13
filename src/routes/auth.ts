/**
 * Email sign-in and session routes.
 *
 *  POST /auth/login            { email } → emails a single-use sign-in link (same answer whether or not the email has an account)
 *  GET  /auth/verify?token=…   confirm page (a button), so link scanners in mail clients can't use the link up
 *  POST /auth/verify           uses the token, sets the session cookie, sends you to the portal
 *  POST /auth/logout           ends the session
 *  GET  /auth/checkout-return  Stripe Checkout success URL: confirms payment, opens a session for a brand-new signup
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { HttpError, newId, nowIso } from "../lib/util";
import { sendMail, signInMail } from "../lib/mailer";
import {
  assertSameOrigin,
  clearSessionCookie,
  clientIp,
  consumeLoginToken,
  createLoginToken,
  createSession,
  destroySession,
  normalizeEmail,
  rateLimit,
  sessionUser,
} from "../lib/session";
import { appOrigin, requireBilling } from "../billing/config";
import { Stripe } from "../billing/stripe";

export const authApp = new Hono<{ Bindings: Env }>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · GEO Observability</title><link rel="stylesheet" href="/assets/base.css"><script src="/assets/theme.js"></script>
<style>body{background:var(--bg);color:var(--text)}main{max-width:460px;margin:12vh auto;padding:0 16px;display:grid;gap:14px}h1{font-family:var(--font-display);font-size:28px;margin:0}p{margin:0;opacity:.85}form{margin:0}</style>
</head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers } });
}

/** Issues a sign-in link for an email that has an account (or is agency staff). Returns whether an email went out. */
export async function sendSignInLink(env: Env, req: Request, email: string, intro: string): Promise<boolean> {
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<{ id: string }>();
  const staff = (env.AGENCY_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).includes(email);
  if (!user && !staff) return false;
  const token = await createLoginToken(env, email);
  const link = `${appOrigin(env, req)}/auth/verify?token=${encodeURIComponent(token)}`;
  await sendMail(env, signInMail(env.APP_NAME || "GEO Observability", email, link, intro));
  return true;
}

authApp.post("/login", async (c) => {
  assertSameOrigin(c.req.raw, c.env.APP_URL);
  let body: { email?: unknown } = {};
  try {
    body = (await c.req.json()) as { email?: unknown };
  } catch {
    throw new HttpError(400, "bad_json", "Body must be JSON");
  }
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, "bad_request", "Enter a valid email address.");
  await rateLimit(c.env, "login_ip", clientIp(c.req.raw), 20, 60);
  await rateLimit(c.env, "login_email", email, 5, 60);
  await sendSignInLink(c.env, c.req.raw, email, "Here's your link to sign in.");
  // Same answer either way, so the form can't be used to find out who has an account.
  return c.json({ sent: true, message: "If that email has a workspace, a sign-in link is on its way. It works once and expires in 15 minutes." });
});

authApp.get("/verify", (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) return page("Sign-in link", `<h1>That link is incomplete</h1><p>Request a new one from the sign-in page.</p><p><a class="btn btn-primary" href="/login/">Go to sign in</a></p>`, 400);
  return page(
    "Sign in",
    `<h1>Sign in to GEO Observability</h1><p>Press the button to finish signing in on this device.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button class="btn btn-primary btn-lg" type="submit">Sign in</button></form>`,
  );
});

authApp.post("/verify", async (c) => {
  await rateLimit(c.env, "verify_ip", clientIp(c.req.raw), 30, 60);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = typeof form.token === "string" ? form.token : "";
  const email = await consumeLoginToken(c.env, token);
  if (!email) {
    return page("Link expired", `<h1>This link has expired or was already used</h1><p>Sign-in links work once and last 15 minutes. Ask for a new one.</p><p><a class="btn btn-primary" href="/login/">Get a new link</a></p>`, 400);
  }
  let user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<{ id: string }>();
  if (!user) {
    // Agency staff signing in for the first time.
    user = { id: newId("usr") };
    await c.env.DB.prepare("INSERT INTO users (id, email) VALUES (?1, ?2)").bind(user.id, email).run();
  }
  await c.env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?2), signup_pending = 0 WHERE id = ?1").bind(user.id, nowIso()).run();
  const { cookie } = await createSession(c.env, user.id, true);
  return new Response(null, { status: 303, headers: { location: "/app/", "set-cookie": cookie, "cache-control": "no-store" } });
});

authApp.post("/logout", async (c) => {
  assertSameOrigin(c.req.raw, c.env.APP_URL);
  await destroySession(c.req.raw, c.env);
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const headers = { "set-cookie": clearSessionCookie(), "cache-control": "no-store" };
  return wantsJson ? new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "content-type": "application/json" } }) : new Response(null, { status: 303, headers: { ...headers, location: "/" } });
});

/**
 * A brand-new signup gets a session straight away, but only when all of these hold: Stripe says the Checkout
 * Session is complete, it's the one we opened for this workspace, it hasn't been used before, and the owner was
 * created by public signup and never signed in (so nobody can pay their way into an existing account).
 * That session is "unverified": it opens only the workspace they just paid for. Everyone else gets a sign-in link.
 */
authApp.get("/checkout-return", async (c) => {
  const cs = c.req.query("cs") ?? "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(cs)) return c.redirect("/login/", 303);
  const { key } = requireBilling(c.env);
  const acct = await c.env.DB.prepare(
    `SELECT b.tenant_id, b.checkout_claimed_at, u.id AS user_id, u.email, u.signup_pending
     FROM billing_accounts b JOIN memberships m ON m.tenant_id = b.tenant_id AND m.role = 'owner' JOIN users u ON u.id = m.user_id
     WHERE b.checkout_ref = ?1 AND b.provider = 'stripe' ORDER BY m.created_at LIMIT 1`,
  )
    .bind(cs)
    .first<{ tenant_id: string; checkout_claimed_at: string | null; user_id: string; email: string; signup_pending: number }>();
  if (!acct) return c.redirect("/login/", 303);

  let session: { status?: string; client_reference_id?: string } = {};
  try {
    session = await new Stripe(key).request("GET", `/v1/checkout/sessions/${cs}`);
  } catch (e) {
    console.error("checkout lookup", e);
  }
  if (session.status !== "complete" || session.client_reference_id !== acct.tenant_id) {
    return page("Payment not finished", `<h1>Your payment isn't finished</h1><p>Stripe hasn't confirmed the card yet. Go back and try again, or contact us if you were charged.</p><p><a class="btn btn-primary" href="/signup/">Back to sign up</a></p>`, 400);
  }

  const dest = "/app/?billing=success#/setup";
  // Already signed in as someone who can open this workspace: just go there.
  const current = await sessionUser(c.req.raw, c.env);
  if (current && current.userId === acct.user_id) return c.redirect(dest, 303);

  const claim = await c.env.DB.prepare("UPDATE billing_accounts SET checkout_claimed_at = ?2 WHERE tenant_id = ?1 AND checkout_claimed_at IS NULL RETURNING tenant_id")
    .bind(acct.tenant_id, nowIso())
    .first();
  if (claim && acct.signup_pending === 1) {
    const { cookie } = await createSession(c.env, acct.user_id, false);
    // Best effort: a link that confirms the email and works for signing in next time.
    try {
      await sendSignInLink(c.env, c.req.raw, acct.email, "Your workspace is ready. Use this link to confirm your email and sign in on any device.");
    } catch (e) {
      console.error("welcome email", e);
    }
    return new Response(null, { status: 303, headers: { location: dest, "set-cookie": cookie, "cache-control": "no-store" } });
  }
  try {
    await sendSignInLink(c.env, c.req.raw, acct.email, "Your payment went through. Use this link to open your workspace.");
  } catch (e) {
    console.error("checkout sign-in email", e);
  }
  return c.redirect("/login/?sent=checkout", 303);
});
