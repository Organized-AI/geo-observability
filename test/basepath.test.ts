/** Serving under app.organizedai.vip/geo-observability: path stripping, link/redirect/cookie fix-ups, workers.dev redirect. */
import { env as rawEnv, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { BASE_HEADER, publicUrl, scopeCookie, serveWithBase, withBase } from "../src/lib/basepath";
import { appOrigin } from "../src/billing/config";

const PUBLIC = "https://app.organizedai.vip/geo-observability";
const env = { ...(rawEnv as unknown as Env), APP_URL: PUBLIC } as Env;

type Seen = { url: string; cookie: string | null; base: string | null };

function stubs(html = "<html><head><title>t</title></head><body></body></html>", setCookie?: string) {
  const seen: { app: Seen[]; assets: Seen[] } = { app: [], assets: [] };
  const record = (list: Seen[]) => (r: Request) => {
    list.push({ url: r.url, cookie: r.headers.get("cookie"), base: r.headers.get(BASE_HEADER) });
    const headers = new Headers({ "content-type": list === seen.assets ? "text/html; charset=utf-8" : "application/json" });
    if (setCookie) headers.append("set-cookie", setCookie);
    return new Response(list === seen.assets ? html : "{}", { headers });
  };
  return { seen, app: record(seen.app), assets: record(seen.assets) };
}

const realApp = (r: Request) => app.fetch(r, env, createExecutionContext());

describe("base path", () => {
  it("reads the base from APP_URL", () => {
    expect(publicUrl({ APP_URL: PUBLIC })).toEqual({ origin: "https://app.organizedai.vip", base: "/geo-observability" });
    expect(publicUrl({ APP_URL: "https://geo.test" })).toEqual({ origin: "https://geo.test", base: "" });
    expect(publicUrl({ APP_URL: "" })).toBeNull();
    expect(withBase("/app/", "/geo-observability")).toBe("/geo-observability/app/");
    expect(withBase("/geo-observability/app/", "/geo-observability")).toBe("/geo-observability/app/");
    expect(withBase("//cdn.example/x.js", "/geo-observability")).toBe("//cdn.example/x.js");
    expect(withBase("https://x.example/", "/geo-observability")).toBe("https://x.example/");
  });

  it("adds the trailing slash to the bare base", async () => {
    const s = stubs();
    const res = await serveWithBase(new Request(`${PUBLIC}?a=1`), env, s.app, s.assets);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${PUBLIC}/?a=1`);
  });

  it("serves assets with the base stripped and rewrites root-relative links", async () => {
    const html = `<html><head><link rel="stylesheet" href="/assets/base.css"></head><body><a href="/signup/">s</a><a href="https://x.example/">x</a><a href="//cdn.example/y">y</a><a href="#top">t</a><form action="/auth/login"></form><script src="/app/app.js"></script></body></html>`;
    const s = stubs(html);
    const res = await serveWithBase(new Request(`${PUBLIC}/login/`), env, s.app, s.assets);
    expect(s.seen.assets[0].url).toBe("https://app.organizedai.vip/login/");
    expect(s.seen.app).toHaveLength(0);
    const out = await res.text();
    expect(out).toContain(`<script>window.__GEO_BASE__="/geo-observability"</script>`);
    expect(out).toContain(`href="/geo-observability/assets/base.css"`);
    expect(out).toContain(`href="/geo-observability/signup/"`);
    expect(out).toContain(`src="/geo-observability/app/app.js"`);
    expect(out).toContain(`action="/geo-observability/auth/login"`);
    expect(out).toContain(`href="https://x.example/"`);
    expect(out).toContain(`href="//cdn.example/y"`);
    expect(out).toContain(`href="#top"`);
  });

  it("sends Worker paths to the app with a trusted base header", async () => {
    const s = stubs();
    await serveWithBase(new Request(`${PUBLIC}/api/me`, { headers: { [BASE_HEADER]: "/evil" } }), env, s.app, s.assets);
    expect(s.seen.app[0].url).toBe("https://app.organizedai.vip/api/me");
    expect(s.seen.app[0].base).toBe("/geo-observability");
    // At the root a forged header never reaches the app.
    await serveWithBase(new Request("https://geo.test/api/me", { headers: { [BASE_HEADER]: "/evil" } }), env, s.app, s.assets);
    expect(s.seen.app[1].base).toBeNull();
  });

  it("scopes the session cookie to the base path, both ways", async () => {
    expect(scopeCookie("__Host-geo_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60", "/geo-observability")).toBe(
      "__Secure-geo_session=abc; Path=/geo-observability; HttpOnly; Secure; SameSite=Lax; Max-Age=60",
    );
    const s = stubs(undefined, "__Host-geo_session=new; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60");
    const res = await serveWithBase(
      new Request(`${PUBLIC}/auth/verify`, { headers: { cookie: "__Host-geo_session=root; __Secure-geo_session=scoped; theme=dark" } }),
      env,
      s.app,
      s.assets,
    );
    expect(s.seen.app[0].cookie).toBe("__Host-geo_session=scoped; theme=dark");
    expect(res.headers.getSetCookie()).toEqual(["__Secure-geo_session=new; Path=/geo-observability; HttpOnly; Secure; SameSite=Lax; Max-Age=60"]);
  });

  it("prefixes the app's own redirects and answers health checks under the base", async () => {
    const health = await serveWithBase(new Request(`${PUBLIC}/healthz`), env, realApp, () => new Response("asset"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const back = await serveWithBase(new Request(`${PUBLIC}/auth/checkout-return?cs=nope`, { redirect: "manual" }), env, realApp, () => new Response("asset"));
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/geo-observability/login/");
  });

  it("moves workers.dev page loads to the public address but keeps machine endpoints", async () => {
    const s = stubs();
    const dev = "https://geo-observability.jordan-691.workers.dev";
    const page = await serveWithBase(new Request(`${dev}/app/?x=1`), env, s.app, s.assets);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`${PUBLIC}/app/?x=1`);
    const verify = await serveWithBase(new Request(`${dev}/auth/verify?token=t`), env, s.app, s.assets);
    expect(verify.headers.get("location")).toBe(`${PUBLIC}/auth/verify?token=t`);
    for (const p of ["/api/v1/brands", "/ingest/hit", "/tap.js", "/mcp", "/healthz"]) {
      const r = await serveWithBase(new Request(`${dev}${p}`), env, s.app, s.assets);
      expect(r.status, p).toBe(200);
    }
    const hook = await serveWithBase(new Request(`${dev}/webhooks/stripe`, { method: "POST", body: "{}" }), env, s.app, s.assets);
    expect(hook.status).toBe(200);
    // Local dev and other hosts are left alone.
    expect((await serveWithBase(new Request("http://localhost:8787/app/"), env, s.app, s.assets)).status).toBe(200);
  });

  it("builds public links from APP_URL, or the request plus its base", () => {
    expect(appOrigin(env, new Request("https://geo-observability.jordan-691.workers.dev/api/x"))).toBe(PUBLIC);
    const noUrl = { ...env, APP_URL: "" } as Env;
    expect(appOrigin(noUrl, new Request("https://a.example/api/x", { headers: { [BASE_HEADER]: "/geo-observability" } }))).toBe("https://a.example/geo-observability");
    expect(appOrigin(noUrl, new Request("https://a.example/api/x"))).toBe("https://a.example");
  });
});
