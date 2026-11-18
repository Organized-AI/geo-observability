import { requestBase } from "../lib/basepath";
import { Hono } from "hono";
import type { Env } from "../env";
import { HttpError } from "../lib/util";
import { issuePass, getPassByKey, passView, revokePass } from "../lib/pass";
import { rateLimit } from "./v1";
import { resolveKey } from "../observability/ingest";

/**
 * Public demo passes. A pass is a read-only API key plus a self-contained MCP URL for the
 * demo workspace. Passes are only issued when DEMO_MODE is on.
 */
export const passApi = new Hono<{ Bindings: Env }>();

async function demoContext(env: Env) {
  if (env.DEMO_MODE !== "true") {
    throw new HttpError(404, "pass_disabled", "Passes are not available right now.");
  }
  const slug = env.DEMO_TENANT_SLUG ?? "demo";
  const tenant = await env.DB.prepare("SELECT id, name, slug FROM tenants WHERE slug = ?1")
    .bind(slug)
    .first<{ id: string; name: string; slug: string }>();
  if (!tenant) {
    throw new HttpError(503, "demo_missing", "Demo data isn't loaded. Run npm run seed:demo.");
  }
  const project = await env.DB.prepare("SELECT id, name FROM projects WHERE tenant_id = ?1 ORDER BY created_at LIMIT 1")
    .bind(tenant.id)
    .first<{ id: string; name: string }>();
  return { tenant, project };
}

const keyFrom = (c: { req: { header: (name: string) => string | undefined } }) =>
  c.req.header("x-api-key") ?? (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");

passApi.post("/", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  await rateLimit(c.env, `pass:${ip}`, 10);
  const { tenant, project } = await demoContext(c.env);
  const issued = await issuePass(c.env, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
  });
  const origin = new URL(c.req.url).origin + requestBase(c.req.raw);
  return c.json(
    {
      ...passView(issued.record, origin),
      api_key: issued.apiKey,
      mcp_url: `${origin}/mcp?pass=${issued.passToken}`,
      docs_url: `${origin}/docs/`,
      api_reference_url: `${origin}/docs/api-introduction/`,
      mcp_setup_url: `${origin}/docs/mcp-setup/`,
    },
    201,
  );
});

passApi.get("/me", async (c) => {
  const key = await resolveKey(c.env, keyFrom(c), ["read"]);
  const found = await getPassByKey(c.env, key.keyId);
  if (!found) throw new HttpError(404, "not_pass", "This key isn't a pass key.");
  return c.json(passView(found.record, new URL(c.req.url).origin + requestBase(c.req.raw)));
});

passApi.post("/revoke", async (c) => {
  const key = await resolveKey(c.env, keyFrom(c), ["read"]);
  return c.json({ ok: await revokePass(c.env, key.keyId) });
});
