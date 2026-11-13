/**
 * Browser sessions and sign-in links.
 *
 * Cookie `__Host-geo_session` holds a random token (HttpOnly, Secure, SameSite=Lax, Path=/); D1 keeps only its
 * SHA-256. Sign-in links carry another random token, also stored hashed, single-use and valid for 15 minutes.
 */
import type { Env } from "../env";
import { HttpError } from "./util";

export const SESSION_COOKIE = "__Host-geo_session";
export const SESSION_DAYS = 30;
export const LINK_MINUTES = 15;

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>()",;:]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec = SESSION_DAYS * 86400): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Creates a session row and returns the Set-Cookie value. `verified` is false only for a session opened from a Checkout return. */
export async function createSession(env: Env, userId: string, verified = true): Promise<{ token: string; cookie: string }> {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, verified, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(token), userId, verified ? 1 : 0, expires)
    .run();
  return { token, cookie: sessionCookie(token) };
}

export interface SessionUser {
  userId: string;
  email: string;
  verified: boolean;
  isAgency: boolean;
}

export async function sessionUser(req: Request, env: Env): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.verified, s.expires_at, s.last_seen_at, u.email, u.is_agency
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?1`,
  )
    .bind(hash)
    .first<{ user_id: string; verified: number; expires_at: string; last_seen_at: string | null; email: string; is_agency: number }>();
  const now = new Date();
  if (!row || row.expires_at <= now.toISOString()) return null;
  // Touch at most once an hour so reads stay cheap.
  if (!row.last_seen_at || Date.parse(row.last_seen_at) < now.getTime() - 3600_000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?2 WHERE id_hash = ?1").bind(hash, now.toISOString()).run();
  }
  return { userId: row.user_id, email: row.email, verified: !!row.verified, isAgency: !!row.is_agency };
}

export async function destroySession(req: Request, env: Env): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1").bind(await sha256(token)).run();
}

export async function createLoginToken(env: Env, email: string): Promise<string> {
  const token = randomToken();
  const expires = new Date(Date.now() + LINK_MINUTES * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?1, ?2, ?3)").bind(await sha256(token), email, expires).run();
  return token;
}

/** Marks the token used and returns its email, or null if it's unknown, used or expired. Single statement, so two clicks can't both win. */
export async function consumeLoginToken(env: Env, token: string): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const now = new Date().toISOString();
  const row = await env.DB.prepare("UPDATE login_tokens SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING email")
    .bind(await sha256(token), now)
    .first<{ email: string }>();
  return row?.email ?? null;
}

/** Counts this event and throws 429 when `key` has more than `limit` events of `kind` in the window. */
export async function rateLimit(env: Env, kind: string, rawKey: string, limit: number, windowMin: number): Promise<void> {
  const key = await sha256(`${kind}:${rawKey}`);
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = ?1 AND key = ?2 AND created_at > ?3").bind(kind, key, since).first<{ n: number }>();
  if ((r?.n ?? 0) >= limit) throw new HttpError(429, "rate_limited", "Too many attempts. Wait a few minutes and try again.");
  await env.DB.prepare("INSERT INTO rate_events (kind, key) VALUES (?1, ?2)").bind(kind, key).run();
  // Light housekeeping: drop rows older than a day now and then.
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_events WHERE created_at < ?1").bind(new Date(Date.now() - 86_400_000).toISOString()).run();
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Rejects cross-site state-changing requests that carry the session cookie. */
export function assertSameOrigin(req: Request, appUrl?: string): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  if (!readCookie(req, SESSION_COOKIE)) return;
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser client; SameSite=Lax already keeps the cookie off cross-site POSTs
  const allowed = new Set([new URL(req.url).origin]);
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      /* ignore bad APP_URL */
    }
  }
  if (!allowed.has(origin)) throw new HttpError(403, "bad_origin", "This request came from another site.");
}
