/**
 * Serving the app under a path on a shared host, e.g. https://app.organizedai.vip/geo-observability.
 *
 * APP_URL (a var) names the public address. When it has a path, that path is the base: a request for
 * `<base>/x` is handled as `/x`, and the response is fixed up on the way out (links, redirects, cookie path).
 * The same Worker still answers at the root of its workers.dev address; there, page loads redirect to APP_URL
 * while the API, ingest, MCP and webhook endpoints keep answering so existing snippets and Stripe keep working.
 * An empty APP_URL turns all of this off.
 */
import type { Env } from "../env";

/** Header the wrapper sets on the inner request so route code can build public links. Never trusted from outside. */
export const BASE_HEADER = "x-geo-base";

/** Paths the Worker answers itself; everything else is a static asset. Mirrors run_worker_first in wrangler.jsonc. */
const WORKER_PATHS = [/^\/api\//, /^\/mcp(\/|$)/, /^\/ingest\//, /^\/share\//, /^\/auth\//, /^\/webhooks\//, /^\/healthz$/, /^\/trace\/stop-reports$/];

/** Machine endpoints that keep answering on any host (no redirect): REST, MCP, ingest, webhooks, tap.js. */
const MACHINE_PATHS = [/^\/api\//, /^\/mcp(\/|$)/, /^\/ingest\//, /^\/webhooks\//, /^\/healthz$/, /^\/tap\.js$/];

const HOST_COOKIE = "__Host-geo_session";
const PATH_COOKIE = "__Secure-geo_session";

export interface PublicUrl {
  origin: string;
  base: string; // "" or "/segment[/segment]" without a trailing slash
}

export function publicUrl(env: Pick<Env, "APP_URL">): PublicUrl | null {
  const raw = (env.APP_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const base = u.pathname.replace(/\/+$/, "");
    if (base && !/^(\/[A-Za-z0-9._~-]+)+$/.test(base)) return null;
    return { origin: u.origin, base };
  } catch {
    return null;
  }
}

export const isWorkerPath = (p: string) => WORKER_PATHS.some((re) => re.test(p));
const isMachinePath = (p: string) => MACHINE_PATHS.some((re) => re.test(p));

/** Prefixes a root-relative URL ("/x", not "//x") with the base, once. */
export function withBase(value: string, base: string): string {
  if (!base || !value.startsWith("/") || value.startsWith("//")) return value;
  if (value === base || value.startsWith(`${base}/`) || value.startsWith(`${base}?`) || value.startsWith(`${base}#`)) return value;
  return `${base}${value}`;
}

/** Turns the Worker's own Set-Cookie (Path=/, __Host- name) into one scoped to the base path. */
export function scopeCookie(setCookie: string, base: string): string {
  let out = setCookie.startsWith(`${HOST_COOKIE}=`) ? PATH_COOKIE + setCookie.slice(HOST_COOKIE.length) : setCookie;
  out = out.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${base}`);
  return out;
}

/** Inbound: the path-scoped cookie is read by code that knows only the __Host- name. */
function translateCookieHeader(cookie: string | null): string | null {
  if (!cookie) return cookie;
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${HOST_COOKIE}=`)) // a stray root cookie never wins over the scoped one
    .map((p) => (p.startsWith(`${PATH_COOKIE}=`) ? HOST_COOKIE + p.slice(PATH_COOKIE.length) : p))
    .join("; ");
}

type Inner = (req: Request) => Promise<Response> | Response;

/**
 * Wraps the Worker's fetch (run_worker_first is true, so every request comes here). `app` handles Worker paths,
 * `assets` everything else.
 */
export async function serveWithBase(req: Request, env: Env, app: Inner, assets: Inner): Promise<Response> {
  const url = new URL(req.url);
  const pub = publicUrl(env);
  const base = pub?.base ?? "";
  const underBase = !!base && (url.pathname === base || url.pathname.startsWith(`${base}/`));

  // Page loads on the workers.dev address move to the public address (local dev and tests stay put).
  if (pub && url.origin !== pub.origin && url.hostname.endsWith(".workers.dev") && (req.method === "GET" || req.method === "HEAD")) {
    const inner = underBase ? url.pathname.slice(base.length) || "/" : url.pathname;
    if (!isMachinePath(inner)) return Response.redirect(`${pub.origin}${base}${inner}${url.search}`, 302);
  }

  const headers = new Headers(req.headers);
  headers.delete(BASE_HEADER);

  if (!underBase) {
    const clean = req.headers.has(BASE_HEADER) ? new Request(req, { headers }) : req;
    return isWorkerPath(url.pathname) ? app(clean) : assets(clean);
  }

  // "/geo-observability" -> "/geo-observability/" so relative URLs resolve under the base.
  if (url.pathname === base) return Response.redirect(`${url.origin}${base}/${url.search}`, 301);

  const innerUrl = new URL(url);
  innerUrl.pathname = url.pathname.slice(base.length) || "/";
  headers.set(BASE_HEADER, base);
  const cookie = translateCookieHeader(headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  const innerReq = new Request(innerUrl.toString(), new Request(req, { headers, redirect: "manual" })) as Request;

  const res = isWorkerPath(innerUrl.pathname) ? await app(innerReq) : await assets(innerReq);
  return rebase(res, base);
}

/** Fixes a response produced for "/x" so it works at "<base>/x". */
export function rebase(res: Response, base: string): Response {
  const headers = new Headers(res.headers);
  const loc = headers.get("location");
  if (loc) headers.set("location", withBase(loc, base));
  const cookies = res.headers.getSetCookie();
  if (cookies.length) {
    headers.delete("set-cookie");
    for (const c of cookies) headers.append("set-cookie", scopeCookie(c, base));
  }

  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("text/html") || res.body === null) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  headers.delete("content-length");
  headers.delete("etag"); // the body differs from the stored asset
  const fix = (attr: string) => ({
    element(el: Element) {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, withBase(v, base));
    },
  });
  const rewritten = new HTMLRewriter()
    .on("head", {
      element(el) {
        el.prepend(`<script>window.__GEO_BASE__=${JSON.stringify(base)}</script>`, { html: true });
      },
    })
    .on("[href]", fix("href"))
    .on("[src]", fix("src"))
    .on("form[action]", fix("action"))
    .transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
  return rewritten;
}

/** Public base for links the Worker writes (emails, Stripe returns, share links, snippets). */
export function requestBase(req: Request): string {
  const b = req.headers.get(BASE_HEADER) ?? "";
  return /^(\/[A-Za-z0-9._~-]+)+$/.test(b) ? b : "";
}
