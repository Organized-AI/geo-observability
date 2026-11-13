// One fetch path for the whole portal: tenant header, JSON handling and readable errors.
import { toast, store } from "./dom.js";

export const session = { tenant: store.get("geo-tenant") || null };

export function setTenant(slug) { session.tenant = slug || null; store.set("geo-tenant", slug || null); }

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function messageFor(status, code, serverMsg) {
  if (status === 0) return "Can't reach the server. Check your connection and try again.";
  if (status === 401) return "You're signed out. Reload the page to sign in again.";
  if (status === 403 && code === "read_only") return "This workspace is read-only, so changes are turned off.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return serverMsg || "That item wasn't found.";
  if (status === 429) return "Too many requests. Wait a little and try again.";
  if (status >= 500) return `The server had a problem (${status}). Try again.`;
  return serverMsg || `Request failed (${status}).`;
}

const listeners = new Set();
export function onAuthError(fn) { listeners.add(fn); }

export async function api(path, opts = {}) {
  const { method = "GET", body, query, headers = {}, tenant = true, quiet = false } = opts;
  let url = path.startsWith("/") ? path : `/api/${path}`;
  const qs = query instanceof URLSearchParams ? query : new URLSearchParams(query || {});
  for (const [k, v] of [...qs]) if (v === "" || v == null) qs.delete(k);
  const q = qs.toString();
  if (q) url += (url.includes("?") ? "&" : "?") + q;
  const h = { Accept: "application/json", ...headers };
  if (tenant && session.tenant) h["X-Tenant"] = session.tenant;
  let payload = body;
  if (body != null && typeof body !== "string" && !(body instanceof Blob) && !(body instanceof FormData)) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, credentials: "same-origin" });
  } catch {
    const err = new ApiError(0, "network", messageFor(0));
    if (method !== "GET" && !quiet) toast(err.message, "error");
    throw err;
  }
  const type = res.headers.get("content-type") || "";
  let data = null;
  if (res.status !== 204) {
    try { data = type.includes("json") ? await res.json() : await res.text(); } catch { data = null; }
  }
  if (!res.ok) {
    const code = data && typeof data === "object" ? data.error : null;
    const msg = data && typeof data === "object" ? data.message : null;
    const err = new ApiError(res.status, code, messageFor(res.status, code, msg));
    if (res.status === 401) listeners.forEach((fn) => fn(err));
    if ((method !== "GET" || res.status === 401) && !quiet) toast(err.message, "error");
    throw err;
  }
  return data;
}

// Report filters → query string, plus a URL builder for links that can't send headers (CSV exports).
export function filterQuery(f, extra = {}) {
  const q = new URLSearchParams();
  for (const k of ["from", "to", "engine", "country", "topic", "tag"]) if (f[k]) q.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") q.set(k, v);
  return q;
}
export function linkUrl(path, q) {
  const qs = new URLSearchParams(q);
  if (session.tenant) qs.set("tenant", session.tenant);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
