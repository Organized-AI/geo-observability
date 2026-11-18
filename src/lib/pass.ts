import type { Env } from "../env";
import { HttpError, newId, sha256Hex } from "./util";
import { newApiKey } from "./tokens";

/** A pass is a short-lived, read-only demo credential. */
export const PASS_DAYS = 14;
export const PASS_API_LIMIT = 200;
export const PASS_MCP_LIMIT = 50;

export interface PassRecord {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  key_id: string;
  project_id: string | null;
  project_name: string | null;
  api_limit: number;
  mcp_limit: number;
  api_calls: number;
  mcp_calls: number;
  created_at: string;
  expires_at: string;
}

export async function issuePass(
  env: Env,
  { tenantId, tenantSlug, projectId, projectName }: { tenantId: string; tenantSlug: string; projectId: string | null; projectName: string | null },
): Promise<{ record: PassRecord; apiKey: string; passToken: string; hash: string }> {
  const key = await newApiKey();
  const keyId = newId("key");
  await env.DB.prepare("INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'read')")
    .bind(keyId, tenantId, "Visibility Pass", key.hash, key.prefix)
    .run();

  // The MCP URL carries this token. Only its hash is stored.
  const passToken = `ps_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const hash = await sha256Hex(passToken);
  const now = new Date();
  const expires = new Date(now.getTime() + PASS_DAYS * 86_400_000);
  const record: PassRecord = {
    id: newId("pas"),
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    key_id: keyId,
    project_id: projectId,
    project_name: projectName,
    api_limit: PASS_API_LIMIT,
    mcp_limit: PASS_MCP_LIMIT,
    api_calls: 0,
    mcp_calls: 0,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };

  await env.DB.prepare(`INSERT INTO demo_passes
    (id, token_hash, key_id, tenant_id, tenant_slug, project_id, project_name, api_limit, mcp_limit, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(record.id, hash, keyId, tenantId, tenantSlug, projectId, projectName, PASS_API_LIMIT, PASS_MCP_LIMIT, record.created_at, record.expires_at).run();
  return { record, apiKey: key.secret, passToken, hash };
}

export async function getPassByKey(env: Env, keyId: string): Promise<{ record: PassRecord; hash: string } | null> {
  const record = await env.DB.prepare("SELECT * FROM demo_passes WHERE key_id = ?1")
    .bind(keyId).first<PassRecord & { token_hash: string }>();
  return record ? { record, hash: record.token_hash } : null;
}

export function passView(record: PassRecord, origin: string) {
  const expires = Date.parse(record.expires_at);
  return {
    pass_id: record.id,
    project_id: record.project_id,
    project_name: record.project_name,
    tenant_slug: record.tenant_slug,
    api_url: `${origin}/api/v1`,
    playground_url: `${origin}/app/?tenant=${encodeURIComponent(record.tenant_slug)}`,
    limits: { api: record.api_limit, mcp: record.mcp_limit },
    usage: { api: record.api_calls, mcp: record.mcp_calls },
    remaining: {
      api: Math.max(0, record.api_limit - record.api_calls),
      mcp: Math.max(0, record.mcp_limit - record.mcp_calls),
    },
    expires_at: record.expires_at,
    days_left: Math.max(0, Math.ceil((expires - Date.now()) / 86_400_000)),
  };
}

/** Atomically reserve a call so simultaneous requests cannot exceed a pass quota. */
async function consumePass(env: Env, record: PassRecord, kind: "api" | "mcp"): Promise<PassRecord> {
  if (Date.parse(record.expires_at) <= Date.now()) {
    throw new HttpError(401, "pass_expired", "This pass has expired. Get a new one at /pass/.");
  }
  const column = kind === "api" ? "api_calls" : "mcp_calls";
  const limit = kind === "api" ? "api_limit" : "mcp_limit";
  const updated = await env.DB.prepare(`UPDATE demo_passes SET ${column} = ${column} + 1
    WHERE key_id = ?1 AND ${column} < ${limit} AND expires_at > ?2
    AND EXISTS (SELECT 1 FROM api_keys WHERE id = ?1 AND revoked_at IS NULL) RETURNING *`)
    .bind(record.key_id, new Date().toISOString()).first<PassRecord>();
  if (!updated) throw new HttpError(429, "pass_limit", "This pass is unavailable or has reached its call limit. Get a new one at /pass/.");
  return updated;
}

/** Non-pass keys are ignored; durable expired pass records always fail closed. */
export async function trackPass(env: Env, keyId: string, kind: "api" | "mcp"): Promise<void> {
  const found = await getPassByKey(env, keyId);
  if (found) await consumePass(env, found.record, kind);
}

export async function resolvePassToken(env: Env, token: string): Promise<PassRecord> {
  const hash = await sha256Hex(token);
  const record = await env.DB.prepare(`SELECT p.* FROM demo_passes p JOIN api_keys k ON k.id = p.key_id
    WHERE p.token_hash = ?1 AND k.revoked_at IS NULL`).bind(hash).first<PassRecord>();
  if (!record) throw new HttpError(401, "bad_pass", "This pass isn't recognised. Get a new one at /pass/.");
  return consumePass(env, record, "mcp");
}

export async function revokePass(env: Env, keyId: string): Promise<boolean> {
  const found = await getPassByKey(env, keyId);
  if (!found) return false;
  await env.DB.prepare("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(keyId).run();
  return true;
}
