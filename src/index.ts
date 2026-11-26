import { Hono } from "hono";
import { readUnsubscribeToken, stopReports } from "./tracing/report-mail";
import { TenantDB } from "./lib/db";
import { getCapture } from "./tracing/policy";
import type { Env, RunJob } from "./env";
import { HttpError } from "./lib/util";
import { portalApi, sharedApi, tenantsApi } from "./routes/portal";
import { rateLimit, v1 } from "./routes/v1";
import { handleMcp } from "./mcp/server";
import { ingestConversions, ingestEdge, ingestHit, resolveKey } from "./observability/ingest";
import { consumeRuns, scheduleDuePasses, scheduleInsights } from "./workflows/scheduler";
import { rollupRecent } from "./metrics/rollup";
import { aggregateUsage } from "./billing/hooks";
import { stripeProvider } from "./billing/stripe";
import { billingApi, signupApi, stripeWebhook } from "./routes/billing";
import { authApp } from "./routes/auth";
import { serveWithBase } from "./lib/basepath";
import { exportResponse, readExport } from "./tracing/otlp";
import { ingestSpans, QuotaError } from "./tracing/store";
import { pruneTraces } from "./tracing/retention";
import { generateDailyReports } from "./tracing/people";

export { RunPromptWorkflow, InsightsWorkflow } from "./workflows/run-prompt";
export { RunProgress } from "./durable/progress";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400);
  console.error("unhandled", err);
  const detail = c.env.ENVIRONMENT === "development" ? ` (${String(err?.message ?? err)})` : "";
  return c.json({ error: "internal", message: `Something went wrong on our side.${detail}` }, 500);
});

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (c.req.path.startsWith("/api/")) c.res.headers.set("cache-control", "no-store");
});

app.get("/healthz", (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT, version: c.env.APP_VERSION ?? "dev", commit: c.env.GIT_COMMIT ?? "dev" }),
);

app.route("/api/shared", sharedApi);
app.route("/api/tenants", tenantsApi);
app.route("/api/v1", v1);
app.route("/auth", authApp);
app.route("/api/signup", signupApi);
app.route("/api/billing", billingApi);
app.route("/api", portalApi);

app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

// Stripe calls this; the signature is the authentication, so keep it outside Cloudflare Access.
app.post("/webhooks/stripe", (c) => stripeWebhook(c.req.raw, c.env));

// ------------------------------------------------------------------ ingest (observability layer)

const ingestCors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-ingest-key",
  "access-control-max-age": "86400",
};

app.options("/ingest/*", () => new Response(null, { status: 204, headers: ingestCors }));

const ingestKey = (req: Request) => req.headers.get("x-ingest-key") ?? new URL(req.url).searchParams.get("k");

app.post("/ingest/edge", async (c) => {
  const key = await resolveKey(c.env, ingestKey(c.req.raw), ["ingest"]);
  return c.json(await ingestEdge(c.env, key, await c.req.json()));
});

/** tap.js uses sendBeacon (text/plain, no preflight); the key travels in the body. */
app.post("/ingest/hit", async (c) => {
  let body: { k?: string; p?: string; url?: string; ref?: string; utm?: string } = {};
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw new HttpError(400, "bad_json", "Body must be JSON");
  }
  const key = await resolveKey(c.env, body.k ?? ingestKey(c.req.raw), ["ingest"]);
  const res = await ingestHit(c.env, key, body);
  return new Response(JSON.stringify(res), { headers: { "content-type": "application/json", ...ingestCors } });
});

app.post("/ingest/conversion", async (c) => {
  const key = await resolveKey(c.env, ingestKey(c.req.raw), ["ingest"]);
  return c.json(await ingestConversions(c.env, key, await c.req.json()));
});

// ------------------------------------------------------------------ ingest (LLM tracing)

/**
 * OTLP/HTTP trace export from a client's own LLM app. Point an OpenTelemetry exporter at `<origin>/ingest/otlp`
 * (it appends `/v1/traces`) with an ingest key in `x-ingest-key` or `Authorization: Bearer`.
 */
app.post("/ingest/otlp/v1/traces", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const secret = c.req.header("x-ingest-key") ?? (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null);
  const key = await resolveKey(c.env, secret, ["ingest"]);
  await rateLimit(c.env, key.keyId, 600);
  const bytes = Number(c.req.header("content-length") ?? 0) || 0;
  const { spans, encoding } = await readExport(c.req.raw);
  let res;
  try {
    res = await ingestSpans(c.env, key.tenantId, spans, c.req.header("x-project-name") ?? null, key.person);
  } catch (err) {
    if (err instanceof QuotaError) return c.json({ error: "quota_exceeded", message: err.message }, 429, { "retry-after": "3600" });
    throw err;
  }
  if (bytes && res.accepted) {
    await new TenantDB(c.env.DB, key.tenantId)
      .run("UPDATE trace_usage SET bytes = bytes + ?3 WHERE tenant_id = ?1 AND month = ?2", new Date().toISOString().slice(0, 7), bytes)
      .catch(() => undefined);
  }
  return exportResponse(encoding, res.rejected, res.reason);
});

/** The stop link in a daily report email: a page with one button, so link scanners can't stop it by visiting. */
const stopPage = (title: string, body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d1d1b;background:#fafaf7}@media(prefers-color-scheme:dark){body{color:#eee;background:#161614}}button{font:inherit;padding:.5rem 1rem;border-radius:8px;border:1px solid currentColor;background:none;color:inherit;cursor:pointer}</style><h1>${title}</h1>${body}`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

app.get("/trace/stop-reports", async (c) => {
  const t = c.req.query("t") ?? "";
  const who = c.env.SHARE_LINK_SECRET ? await readUnsubscribeToken(c.env.SHARE_LINK_SECRET, t) : null;
  if (!who) return stopPage("This link has expired", "<p>Ask a workspace owner, or turn the emails off from your report page.</p>");
  const safe = t.replace(/[^A-Za-z0-9._-]/g, "");
  return stopPage("Stop daily report emails?", `<p>You will still find your reports in the portal.</p><form method="post"><input type="hidden" name="t" value="${safe}"><button type="submit">Stop the emails</button></form>`);
});

app.post("/trace/stop-reports", async (c) => {
  const form = await c.req.parseBody();
  const who = c.env.SHARE_LINK_SECRET ? await readUnsubscribeToken(c.env.SHARE_LINK_SECRET, String(form.t ?? "")) : null;
  if (!who) return stopPage("This link has expired", "<p>Ask a workspace owner to stop the emails.</p>");
  await stopReports(new TenantDB(c.env.DB, who.tenantId), who.userId);
  return stopPage("Done", "<p>You won't get daily report emails any more. Your reports are still in the portal.</p>");
});

/** What a key may send: the installer shows it, and the hook narrows what it sends to match. */
app.get("/ingest/otlp/policy", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const secret = c.req.header("x-ingest-key") ?? (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null);
  const key = await resolveKey(c.env, secret, ["ingest"]);
  await rateLimit(c.env, key.keyId, 600);
  return c.json({ capture: await getCapture(new TenantDB(c.env.DB, key.tenantId)), person: key.person });
});

app.all("/api/*", (c) => c.json({ error: "not_found", message: "No such endpoint" }, 404));

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return serveWithBase(req, env, (r) => app.fetch(r, env, ctx), (r) => env.ASSETS.fetch(r));
  },

  async queue(batch: MessageBatch<RunJob>, env: Env) {
    await consumeRuns(batch, env);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const when = new Date(event.scheduledTime);
    switch (event.cron) {
      case "0 6 * * *":
        ctx.waitUntil(scheduleDuePasses(env, when));
        break;
      case "0 9 * * *":
        ctx.waitUntil(scheduleInsights(env, when));
        break;
      default:
        ctx.waitUntil(Promise.all([rollupRecent(env, when), aggregateUsage(env, stripeProvider(env)), pruneTraces(env, when), generateDailyReports(env, when)]));
    }
  },
} satisfies ExportedHandler<Env, RunJob>;

export { app };
