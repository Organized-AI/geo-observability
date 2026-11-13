import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";
import { TenantDB, type TenantRow } from "./db";
import { HttpError, newId } from "./util";
import { sessionUser } from "./session";

export type Role = "owner" | "editor" | "viewer";

export interface Session {
  email: string;
  name: string | null;
  userId: string | null;
  isAgency: boolean;
  demo: boolean;
  tenants: { id: string; name: string; slug: string; role: Role }[];
  tenant: TenantRow;
  role: Role;
  readOnly: boolean;
  /** Set by the portal when billing makes the workspace read-only (no card yet, unpaid, canceled). */
  billingLocked?: boolean;
  tdb: TenantDB;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function accessEmail(req: Request, env: Env): Promise<string | null> {
  if (env.ENVIRONMENT === "development" && env.DEV_AUTH_EMAIL) return env.DEV_AUTH_EMAIL.toLowerCase();
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: env.ACCESS_AUD });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    return email;
  } catch {
    return null;
  }
}

function agencyEmails(env: Env & { AGENCY_EMAILS?: string }): Set<string> {
  return new Set(
    (env.AGENCY_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface Identity {
  email: string;
  /** Email proven: a used sign-in link, Cloudflare Access, or local development. */
  verified: boolean;
  via: "session" | "access" | "dev";
}

/** Who is calling: session cookie (sign-in link) → Cloudflare Access (optional, for staff) → local dev email. */
export async function identify(req: Request, env: Env): Promise<Identity | null> {
  const s = await sessionUser(req, env);
  if (s) return { email: s.email, verified: s.verified, via: "session" };
  const email = await accessEmail(req, env);
  if (!email) return null;
  return { email, verified: true, via: env.ENVIRONMENT === "development" && env.DEV_AUTH_EMAIL ? "dev" : "access" };
}

/**
 * Resolves who is calling and which tenant they act on.
 * Order: session cookie / Access identity → (demo mode, anonymous visitors only) read-only demo tenant → 401.
 */
export async function resolveSession(req: Request, env: Env & { AGENCY_EMAILS?: string }): Promise<Session> {
  const who = await identify(req, env);
  const wanted = req.headers.get("x-tenant") ?? new URL(req.url).searchParams.get("tenant");

  if (!who) {
    if (env.DEMO_MODE === "true") return demoSession(env);
    throw new HttpError(401, "unauthenticated", "Sign in to use the portal.");
  }
  const email = who.email;

  // Upsert the user; agency staff are named in AGENCY_EMAILS.
  let user = await env.DB.prepare("SELECT id, name, is_agency FROM users WHERE email = ?1")
    .bind(email)
    .first<{ id: string; name: string | null; is_agency: number }>();
  const shouldBeAgency = agencyEmails(env).has(email) && who.verified ? 1 : 0;
  if (!user) {
    const id = newId("usr");
    await env.DB.prepare("INSERT INTO users (id, email, is_agency) VALUES (?1, ?2, ?3)").bind(id, email, shouldBeAgency).run();
    user = { id, name: null, is_agency: shouldBeAgency };
  } else if (shouldBeAgency && !user.is_agency) {
    await env.DB.prepare("UPDATE users SET is_agency = 1 WHERE id = ?1").bind(user.id).run();
    user.is_agency = 1;
  }

  // Users on a tenant's email domain join it as viewers the first time they arrive, but only with a proven email.
  if (who.verified) {
    const domain = email.split("@")[1] ?? "";
    await env.DB.prepare(
      `INSERT OR IGNORE INTO memberships (tenant_id, user_id, role)
       SELECT id, ?1, 'viewer' FROM tenants WHERE email_domain = ?2`,
    )
      .bind(user.id, domain)
      .run();
  }

  let tenants: { id: string; name: string; slug: string; role: Role }[];
  if (user.is_agency) {
    const r = await env.DB.prepare("SELECT id, name, slug, 'owner' AS role FROM tenants ORDER BY name").all<{
      id: string;
      name: string;
      slug: string;
      role: Role;
    }>();
    tenants = r.results ?? [];
  } else {
    const r = await env.DB.prepare(
      `SELECT t.id, t.name, t.slug, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = ?1 ORDER BY t.name`,
    )
      .bind(user.id)
      .all<{ id: string; name: string; slug: string; role: Role }>();
    tenants = r.results ?? [];
  }

  if (!tenants.length) throw new HttpError(403, "no_tenant", "Your account isn't linked to a workspace yet.");
  const chosen = (wanted && tenants.find((t) => t.id === wanted || t.slug === wanted)) || tenants[0];
  if (wanted && chosen.id !== wanted && chosen.slug !== wanted) {
    throw new HttpError(403, "forbidden", "You don't have access to that workspace.");
  }
  const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(chosen.id).first<TenantRow>();
  if (!tenant) throw new HttpError(404, "not_found", "Workspace not found");
  return {
    email,
    name: user.name,
    userId: user.id,
    isAgency: !!user.is_agency,
    demo: false,
    tenants,
    tenant,
    role: chosen.role,
    readOnly: chosen.role === "viewer",
    tdb: new TenantDB(env.DB, tenant.id),
  };
}

async function demoSession(env: Env, email = "demo@visitor"): Promise<Session> {
  const slug = env.DEMO_TENANT_SLUG ?? "demo";
  const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(slug).first<TenantRow>();
  if (!tenant) throw new HttpError(503, "demo_missing", "Demo data hasn't been loaded. Run npm run seed:demo.");
  return {
    email,
    name: "Demo visitor",
    userId: null,
    isAgency: false,
    demo: true,
    tenants: [{ id: tenant.id, name: tenant.name, slug: tenant.slug, role: "viewer" }],
    tenant,
    role: "viewer",
    readOnly: true,
    tdb: new TenantDB(env.DB, tenant.id),
  };
}

/** The caller's email if they are agency staff (AGENCY_EMAILS or users.is_agency), else null. */
export async function agencyEmail(req: Request, env: Env & { AGENCY_EMAILS?: string }): Promise<string | null> {
  const who = await identify(req, env);
  if (!who || !who.verified) return null;
  const email = who.email;
  if (agencyEmails(env).has(email)) return email;
  const u = await env.DB.prepare("SELECT is_agency FROM users WHERE email = ?1").bind(email).first<{ is_agency: number }>();
  return u?.is_agency ? email : null;
}

export function requireWrite(s: Session): void {
  if (s.billingLocked) throw new HttpError(403, "billing_locked", "Changes are paused until billing is sorted out. An owner can sort it out under Usage & API.");
  if (s.readOnly) throw new HttpError(403, "read_only", s.demo ? "The demo is read-only." : "Your role is read-only.");
}

export function requireOwner(s: Session): void {
  if (s.role !== "owner") throw new HttpError(403, "forbidden", "Only an owner can do that.");
}
