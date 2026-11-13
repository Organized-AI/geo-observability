import { Hono } from "hono";
import type { Env } from "../env";
import { agencyEmail, requireOwner, requireWrite, resolveSession, type Session } from "../lib/auth";
import { HttpError, newId, nowIso, parseCsv, parseJson, toCsv, today, addDays } from "../lib/util";
import { newApiKey, signShare, verifyShare } from "../lib/tokens";
import { engineList, ENGINE_IDS, getEngine } from "../engines/registry";
import { parseFilters } from "../metrics/filters";
import { chats, domainReport, loadBrands, overview, promptPerformance, urlReport } from "../metrics/report";
import { crawlerReport, pagesReport, referralReport } from "../observability/pages";
import { enqueuePass } from "../workflows/scheduler";
import { progressStub } from "../durable/progress";
import { contentBrief, draftProfile, generatePrompts, suggestCompetitors, suggestTopics, type Profile } from "../onboarding/assist";
import { billingBanner, billingLocks, billingStatus } from "../billing/hooks";
import { assertSameOrigin, rateLimit } from "../lib/session";
import { emailFailureReason, mailerKind, parseFrom, sendMail } from "../lib/mailer";
import { STARTER_MODEL_LIMIT } from "./billing";
import { appOrigin } from "../billing/config";
import { TenantDB, type BrandRow, type ProjectRow, type PromptRow } from "../lib/db";

export type AppEnv = { Bindings: Env; Variables: { session: Session } };

const INTENTS = ["informational", "commercial", "transactional", "navigational"];
const COUNTRY = /^[A-Z]{2}$/;

const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  assertSameOrigin(c.req.raw, c.env.APP_URL);
  const s = await resolveSession(c.req.raw, c.env);
  // A Stripe-billed workspace with no card, an unpaid invoice or an ended subscription is read-only for its own users.
  if (!s.demo && !s.isAgency) {
    const b = await billingStatus(c.env, s.tenant.id);
    if (b.provider === "stripe" && billingLocks(b.status)) {
      s.billingLocked = true;
      s.readOnly = true;
    }
  }
  c.set("session", s);
  await next();
});

async function body<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "bad_json", "Body must be JSON");
  }
}

const str = (v: unknown, max: number, field: string, required = true): string => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, "bad_request", `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, "bad_request", `${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, "bad_request", `${field} is longer than ${max} characters`);
  return s;
};
const strList = (v: unknown, maxItems = 50, maxLen = 120): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems) : [];
const cleanDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").slice(0, 120);

async function audit(s: Session, action: string, detail: unknown) {
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, ?4, ?5)", newId("aud"), s.email, action, JSON.stringify(detail).slice(0, 2000));
}

// ------------------------------------------------------------------ session

/** Agency staff create client workspaces. Mounted before the session middleware: an agency may have none yet. */
export const tenantsApi = new Hono<{ Bindings: Env }>();
tenantsApi.post("/", async (c) => {
  const email = await agencyEmail(c.req.raw, c.env);
  if (!email) throw new HttpError(403, "forbidden", "Only agency staff can create workspaces");
  const b = await body<{ name?: string; slug?: string; email_domain?: string; plan?: string }>(c);
  const name = str(b.name, 120, "name");
  const slug = (b.slug ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!slug) throw new HttpError(400, "bad_request", "slug is required");
  const exists = await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?1").bind(slug).first();
  if (exists) throw new HttpError(409, "conflict", "That slug is taken");
  const id = newId("ten");
  await c.env.DB.prepare("INSERT INTO tenants (id, name, slug, email_domain, plan, model_limit) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, name, slug, b.email_domain ? cleanDomain(b.email_domain) : null, b.plan ?? "starter", STARTER_MODEL_LIMIT)
    .run();
  return c.json({ id, name, slug }, 201);
});


api.get("/me", async (c) => {
  const s = c.get("session");
  const b = await billingStatus(c.env, s.tenant.id);
  // The website given at signup, so setup can start from it instead of asking again.
  const signup = s.demo
    ? null
    : await s.tdb.first<{ detail: string | null }>("SELECT detail FROM audit_log WHERE tenant_id = ?1 AND action = 'workspace.signup' ORDER BY created_at LIMIT 1");
  const signupWebsite = (parseJson(signup?.detail, {}) as { website?: unknown }).website;
  return c.json({
    user: { email: s.email, name: s.name, is_agency: s.isAgency },
    tenants: s.tenants,
    tenant: {
      id: s.tenant.id,
      name: s.tenant.name,
      slug: s.tenant.slug,
      role: s.role,
      plan: s.tenant.plan,
      limits: { prompts: s.tenant.prompt_limit, projects: s.tenant.project_limit, models: s.tenant.model_limit, countries: s.tenant.country_limit },
      signup_website: typeof signupWebsite === "string" ? signupWebsite : null,
    },
    demo: s.demo,
    read_only: s.readOnly,
    app_name: c.env.APP_NAME,
    billing: {
      provider: b.provider,
      status: b.status,
      banner: billingBanner(b.status, b.grace_until),
      locked: !!s.billingLocked,
      grace_until: b.grace_until,
      can_manage: s.role === "owner" && !s.demo && b.provider === "stripe",
    },
  });
});

// Sign-in email health: which provider is in use and how the latest sends to you went (agency staff see all).
api.get("/email/status", async (c) => {
  const s = c.get("session");
  if (!s.isAgency) requireOwner(s);
  const from = parseFrom(c.env);
  const rows = await c.env.DB.prepare(
    `SELECT to_email, provider, status, code, detail, message_id, created_at FROM email_log
     WHERE ?1 = 1 OR to_email = ?2 ORDER BY created_at DESC LIMIT 10`,
  )
    .bind(s.isAgency ? 1 : 0, s.email)
    .all()
    .catch(() => ({ results: [] }));
  const recent = (rows.results ?? []).map((r: any) => ({ ...r, reason: r.status === "failed" ? emailFailureReason(String(r.code ?? ""), from.email.split("@")[1] ?? "") : null }));
  return c.json({ provider: mailerKind(c.env), from: from.email || null, from_domain: from.email.split("@")[1] ?? null, recent });
});

// Sends a test sign-in email to the signed-in owner, so a setup problem shows up as a plain reason.
api.post("/email/test", async (c) => {
  const s = c.get("session");
  if (!s.isAgency) requireOwner(s);
  await rateLimit(c.env, "email_test", s.email, 5, 60);
  await sendMail(c.env, { to: s.email, subject: `Test email from ${c.env.APP_NAME || "GEO Observability"}`, text: "Email sending works. Sign-in links will arrive the same way." });
  return c.json({ sent: true, to: s.email, provider: mailerKind(c.env) });
});

api.get("/engines", (c) => c.json(engineList(c.env)));

api.get("/usage", async (c) => {
  const s = c.get("session");
  const month = nowIso().slice(0, 7);
  const byEngine = await s.tdb.all<{ engine: string; answers: number; cost_micros: number }>(
    "SELECT engine, COUNT(*) AS answers, SUM(cost_micros) AS cost_micros FROM runs WHERE tenant_id = ?1 AND status = 'done' AND substr(run_date,1,7) = ?2 GROUP BY engine",
    month,
  );
  const b = await billingStatus(c.env, s.tenant.id);
  return c.json({
    month,
    answers_run: byEngine.reduce((a, e) => a + e.answers, 0),
    llm_cost_micros: byEngine.reduce((a, e) => a + (e.cost_micros ?? 0), 0),
    spend_cap_micros: s.tenant.monthly_spend_cap_micros,
    by_engine: byEngine,
    billing: { provider: b.provider, status: b.status },
  });
});

api.get("/keys", async (c) => {
  const s = c.get("session");
  return c.json(await s.tdb.all("SELECT id, name, prefix, scope, created_at, last_used_at FROM api_keys WHERE tenant_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC"));
});

api.post("/keys", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  const b = await body<{ name?: string; scope?: string }>(c);
  const scope = b.scope === "ingest" ? "ingest" : "read";
  const k = await newApiKey();
  const id = newId("key");
  await s.tdb.run("INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scope) VALUES (?2, ?1, ?3, ?4, ?5, ?6)", id, str(b.name, 80, "name"), k.hash, k.prefix, scope);
  await audit(s, "api_key.create", { id, scope });
  return c.json({ id, secret: k.secret, prefix: k.prefix, scope }, 201);
});

api.delete("/keys/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  await s.tdb.run("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?1 AND id = ?2", c.req.param("id"));
  await audit(s, "api_key.revoke", { id: c.req.param("id") });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ projects

api.get("/projects", async (c) => {
  const s = c.get("session");
  return c.json(await s.tdb.all("SELECT id, name, domain, schedule, onboarding_step, created_at FROM projects WHERE tenant_id = ?1 ORDER BY created_at"));
});

api.post("/projects", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const b = await body<{ name?: string; domain?: string }>(c);
  const count = await s.tdb.first<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE tenant_id = ?1");
  if ((count?.n ?? 0) >= s.tenant.project_limit) throw new HttpError(403, "limit", `Your plan allows ${s.tenant.project_limit} project(s).`);
  const name = str(b.name, 120, "name");
  const domain = cleanDomain(str(b.domain, 200, "domain"));
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new HttpError(400, "bad_request", "Enter a domain like example.com");
  const id = newId("prj");
  await s.tdb.batch([
    s.tdb.prepare("INSERT INTO projects (id, tenant_id, name, domain) VALUES (?2, ?1, ?3, ?4)", id, name, domain),
    s.tdb.prepare("INSERT INTO brand_profiles (project_id, tenant_id) VALUES (?2, ?1)", id),
    s.tdb.prepare("INSERT INTO brands (id, tenant_id, project_id, name, domains, is_own) VALUES (?2, ?1, ?3, ?4, ?5, 1)", newId("br"), id, name, JSON.stringify([domain])),
    ...["chatgpt", "claude", "gemini"].map((e) => s.tdb.prepare("INSERT INTO project_models (tenant_id, project_id, engine) VALUES (?1, ?2, ?3)", id, e)),
    s.tdb.prepare("INSERT INTO project_countries (tenant_id, project_id, country) VALUES (?1, ?2, 'US')", id),
  ]);
  await audit(s, "project.create", { id, domain });
  return c.json(await s.tdb.project(id), 201);
});

api.get("/projects/:pid", async (c) => {
  const s = c.get("session");
  const project = await s.tdb.project(c.req.param("pid"));
  const prof = await s.tdb.first<{ what_you_sell: string | null; buyers: string | null; markets: string | null; facts: string | null }>(
    "SELECT what_you_sell, buyers, markets, facts FROM brand_profiles WHERE tenant_id = ?1 AND project_id = ?2",
    project.id,
  );
  const counts = await s.tdb.first(
    `SELECT (SELECT COUNT(*) FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active') AS prompts,
            (SELECT COUNT(*) FROM brands WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active') AS brands,
            (SELECT COUNT(*) FROM topics WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active') AS topics,
            (SELECT COUNT(*) FROM runs WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'done') AS runs`,
    project.id,
  );
  return c.json({
    project,
    profile: { what_you_sell: prof?.what_you_sell ?? "", buyers: prof?.buyers ?? "", markets: parseJson(prof?.markets, []), facts: parseJson(prof?.facts, []) },
    counts,
  });
});

api.patch("/projects/:pid", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ name?: string; schedule?: string; onboarding_step?: string | number }>(c);
  const schedule = b.schedule && ["daily", "weekly", "paused"].includes(b.schedule) ? b.schedule : p.schedule;
  // The wizard stores its step as a name or as an index 0-6; "done" (or 7) means onboarding is finished.
  const rawStep = b.onboarding_step === undefined || b.onboarding_step === null ? "" : String(b.onboarding_step);
  const step = rawStep === "7" ? "done" : ["brand", "profile", "topics", "prompts", "competitors", "models", "engines", "finish", "done"].includes(rawStep) || /^[0-6]$/.test(rawStep) ? rawStep : p.onboarding_step;
  await s.tdb.run("UPDATE projects SET name = ?3, schedule = ?4, onboarding_step = ?5 WHERE tenant_id = ?1 AND id = ?2", p.id, b.name ? str(b.name, 120, "name") : p.name, schedule, step);
  return c.json(await s.tdb.project(p.id));
});

api.delete("/projects/:pid", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  const p = await s.tdb.project(c.req.param("pid"));
  await s.tdb.run("DELETE FROM projects WHERE tenant_id = ?1 AND id = ?2", p.id);
  await audit(s, "project.delete", { id: p.id });
  return c.json({ ok: true });
});

api.put("/projects/:pid/profile", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<Partial<Profile>>(c);
  const markets = (Array.isArray(b.markets) ? b.markets : [])
    .filter((m) => COUNTRY.test(String(m?.country ?? "").toUpperCase()))
    .map((m) => ({ country: String(m.country).toUpperCase(), language: String(m.language ?? "en").slice(0, 5) }))
    .slice(0, 20);
  await s.tdb.run(
    `INSERT INTO brand_profiles (project_id, tenant_id, what_you_sell, buyers, markets, facts, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(project_id) DO UPDATE SET what_you_sell = excluded.what_you_sell, buyers = excluded.buyers, markets = excluded.markets,
       facts = excluded.facts, updated_at = excluded.updated_at WHERE brand_profiles.tenant_id = ?1`,
    p.id,
    str(b.what_you_sell, 1000, "what_you_sell", false),
    str(b.buyers, 600, "buyers", false),
    JSON.stringify(markets),
    JSON.stringify(strList(b.facts, 20, 300)),
    nowIso(),
  );
  if (p.onboarding_step === "brand") await s.tdb.run("UPDATE projects SET onboarding_step = 'topics' WHERE tenant_id = ?1 AND id = ?2", p.id);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ onboarding assists

async function profileOf(tdb: TenantDB, projectId: string): Promise<Profile> {
  const r = await tdb.first<{ what_you_sell: string | null; buyers: string | null; markets: string | null; facts: string | null }>(
    "SELECT what_you_sell, buyers, markets, facts FROM brand_profiles WHERE tenant_id = ?1 AND project_id = ?2",
    projectId,
  );
  return { what_you_sell: r?.what_you_sell ?? "", buyers: r?.buyers ?? "", markets: parseJson(r?.markets, []), facts: parseJson(r?.facts, []) };
}

api.post("/projects/:pid/onboarding/profile", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  return c.json(await draftProfile(c.env, p.name, p.domain, { tenant: s.tenant.id, project: p.id, engine: "onboarding" }));
});

api.post("/projects/:pid/onboarding/topics", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const names = await suggestTopics(c.env, p.name, await profileOf(s.tdb, p.id), { tenant: s.tenant.id, project: p.id, engine: "onboarding" });
  const existing = await s.tdb.all<{ name: string }>("SELECT name FROM topics WHERE tenant_id = ?1 AND project_id = ?2", p.id);
  const fresh = names.filter((n) => !existing.some((e) => e.name.toLowerCase() === n.toLowerCase()));
  const rows = fresh.map((name) => ({ id: newId("top"), name, status: "suggested" }));
  await s.tdb.batch(rows.map((r) => s.tdb.prepare("INSERT INTO topics (id, tenant_id, project_id, name, status) VALUES (?2, ?1, ?3, ?4, 'suggested')", r.id, p.id, r.name)));
  return c.json({ topics: rows });
});

api.post("/projects/:pid/onboarding/prompts", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ count?: number; branded_share?: number; intent_mix?: Record<string, number>; country?: string; language?: string; topic_ids?: string[] }>(c);
  const topics = await s.tdb.all<{ id: string; name: string }>(
    "SELECT id, name FROM topics WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active'",
    p.id,
  );
  const chosen = b.topic_ids?.length ? topics.filter((t) => b.topic_ids!.includes(t.id)) : topics;
  const country = String(b.country ?? "US").toUpperCase();
  if (!COUNTRY.test(country)) throw new HttpError(400, "bad_request", "country must be an ISO-2 code");
  const drafts = await generatePrompts(
    c.env,
    p.name,
    await profileOf(s.tdb, p.id),
    chosen.map((t) => t.name),
    {
      count: Number(b.count ?? 10),
      brandedShare: Number(b.branded_share ?? 0.2),
      intentMix: b.intent_mix ?? { informational: 0.25, commercial: 0.5, transactional: 0.25 },
      country,
    },
    { tenant: s.tenant.id, project: p.id, engine: "onboarding" },
  );
  const rows = drafts.map((d) => ({
    id: newId("pr"),
    text: d.text,
    country,
    language: String(b.language ?? "en").slice(0, 5),
    intent: d.intent,
    branded: d.branded ? 1 : 0,
    topic_id: chosen.find((t) => t.name.toLowerCase() === d.topic.toLowerCase())?.id ?? chosen[0]?.id ?? null,
    tags: "[]",
    status: "suggested",
  }));
  await s.tdb.batch(
    rows.map((r) =>
      s.tdb.prepare(
        "INSERT INTO prompts (id, tenant_id, project_id, topic_id, text, country, language, intent, branded, status) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'suggested')",
        r.id,
        p.id,
        r.topic_id,
        r.text,
        r.country,
        r.language,
        r.intent,
        r.branded,
      ),
    ),
  );
  return c.json({ prompts: rows.map((r) => ({ ...r, tags: [], branded: !!r.branded })) });
});

api.post("/projects/:pid/onboarding/competitors", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const list = await suggestCompetitors(c.env, p.name, await profileOf(s.tdb, p.id), { tenant: s.tenant.id, project: p.id, engine: "onboarding" });
  const existing = await loadBrands(s.tdb, p.id, ["active", "suggested", "rejected"]);
  const fresh = list.filter((x) => !existing.some((e) => e.name.toLowerCase() === x.name.toLowerCase()));
  const rows = fresh.map((x) => ({ id: newId("br"), name: x.name, domains: x.domain ? [x.domain] : [] }));
  await s.tdb.batch(
    rows.map((r) => s.tdb.prepare("INSERT INTO brands (id, tenant_id, project_id, name, domains, status) VALUES (?2, ?1, ?3, ?4, ?5, 'suggested')", r.id, p.id, r.name, JSON.stringify(r.domains))),
  );
  return c.json({ brands: rows.map((r) => ({ ...r, aliases: [], socials: [], regex: null, is_own: false, status: "suggested", color: null })) });
});

api.post("/projects/:pid/onboarding/finish", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const active = await s.tdb.first<{ n: number }>("SELECT COUNT(*) AS n FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active'", p.id);
  if (!active?.n) throw new HttpError(400, "no_prompts", "Accept at least one prompt first.");
  await s.tdb.run("UPDATE projects SET onboarding_step = 'done' WHERE tenant_id = ?1 AND id = ?2", p.id);
  const queued = await enqueuePass(c.env, s.tenant.id, p.id);
  await audit(s, "project.first_run", { id: p.id, queued });
  return c.json({ queued });
});

api.get("/projects/:pid/progress", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  return c.json(await progressStub(c.env, p.id).get());
});

api.post("/projects/:pid/run", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  return c.json({ queued: await enqueuePass(c.env, s.tenant.id, p.id) });
});

// ------------------------------------------------------------------ topics

api.get("/projects/:pid/topics", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  return c.json(await s.tdb.all("SELECT id, name, status FROM topics WHERE tenant_id = ?1 AND project_id = ?2 ORDER BY status, name", p.id));
});

api.post("/projects/:pid/topics", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ name?: string }>(c);
  const id = newId("top");
  await s.tdb.run("INSERT INTO topics (id, tenant_id, project_id, name, status) VALUES (?2, ?1, ?3, ?4, 'active')", id, p.id, str(b.name, 60, "name"));
  return c.json({ id, name: b.name, status: "active" }, 201);
});

api.patch("/projects/:pid/topics/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ name?: string; status?: string }>(c);
  const cur = await s.tdb.first<{ name: string; status: string }>("SELECT name, status FROM topics WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  if (!cur) throw new HttpError(404, "not_found", "Topic not found");
  if (b.status === "rejected") {
    await s.tdb.run("DELETE FROM topics WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
    return c.json({ ok: true, deleted: true });
  }
  const status = b.status && ["active", "suggested"].includes(b.status) ? b.status : cur.status;
  await s.tdb.run("UPDATE topics SET name = ?4, status = ?5 WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"), b.name ? str(b.name, 60, "name") : cur.name, status);
  return c.json({ ok: true });
});

api.delete("/projects/:pid/topics/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  await s.tdb.run("DELETE FROM topics WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ prompts

function promptOut(r: PromptRow & { topic?: string | null }) {
  return { ...r, branded: !!r.branded, tags: parseJson<string[]>(r.tags, []) };
}

async function activePromptRoom(s: Session, projectId: string, adding: number) {
  const n = await s.tdb.first<{ n: number }>("SELECT COUNT(*) AS n FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active'", projectId);
  if ((n?.n ?? 0) + adding > s.tenant.prompt_limit) throw new HttpError(403, "limit", `Your plan tracks up to ${s.tenant.prompt_limit} active prompts.`);
}

api.get("/projects/:pid/prompts", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const status = c.req.query("status");
  const rows = await s.tdb.all<PromptRow & { topic: string | null }>(
    `SELECT pr.*, t.name AS topic FROM prompts pr LEFT JOIN topics t ON t.id = pr.topic_id AND t.tenant_id = ?1
     WHERE pr.tenant_id = ?1 AND pr.project_id = ?2 ${status ? "AND pr.status = ?3" : ""} ORDER BY pr.status, pr.created_at`,
    ...(status ? [p.id, status] : [p.id]),
  );
  return c.json(rows.map(promptOut));
});

api.post("/projects/:pid/prompts", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ text?: string; country?: string; topic_id?: string; tags?: string[]; intent?: string; branded?: boolean; status?: string }>(c);
  const status = b.status === "suggested" ? "suggested" : "active";
  if (status === "active") await activePromptRoom(s, p.id, 1);
  const country = String(b.country ?? "US").toUpperCase();
  if (!COUNTRY.test(country)) throw new HttpError(400, "bad_request", "country must be an ISO-2 code");
  const id = newId("pr");
  await s.tdb.run(
    "INSERT INTO prompts (id, tenant_id, project_id, topic_id, text, country, intent, branded, tags, status) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    id,
    p.id,
    b.topic_id ?? null,
    str(b.text, 200, "text"),
    country,
    INTENTS.includes(String(b.intent)) ? String(b.intent) : "commercial",
    b.branded ? 1 : 0,
    JSON.stringify(strList(b.tags, 20, 40)),
    status,
  );
  const row = await s.tdb.first<PromptRow>("SELECT * FROM prompts WHERE tenant_id = ?1 AND id = ?2", id);
  return c.json(promptOut(row!), 201);
});

/** CSV columns: prompt, country, topic, then any number of tags. A header row is optional. */
api.post("/projects/:pid/prompts/import", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const text = (await c.req.text()).slice(0, 500_000);
  const rows = parseCsv(text);
  if (rows.length && /^prompt$/i.test(rows[0][0]?.trim() ?? "")) rows.shift();
  const errors: { line: number; message: string }[] = [];
  const topics = await s.tdb.all<{ id: string; name: string }>("SELECT id, name FROM topics WHERE tenant_id = ?1 AND project_id = ?2", p.id);
  const stmts: D1PreparedStatement[] = [];
  const newTopics = new Map<string, string>();
  rows.forEach((r, i) => {
    const [promptText, countryRaw, topicName, ...tags] = r.map((x) => x.trim());
    const country = (countryRaw || "US").toUpperCase();
    if (!promptText) return errors.push({ line: i + 1, message: "Empty prompt" });
    if (promptText.length > 200) return errors.push({ line: i + 1, message: "Prompt is longer than 200 characters" });
    if (!COUNTRY.test(country)) return errors.push({ line: i + 1, message: `"${countryRaw}" isn't an ISO-2 country code` });
    let topicId: string | null = null;
    if (topicName) {
      topicId = topics.find((t) => t.name.toLowerCase() === topicName.toLowerCase())?.id ?? newTopics.get(topicName.toLowerCase()) ?? null;
      if (!topicId) {
        topicId = newId("top");
        newTopics.set(topicName.toLowerCase(), topicId);
        stmts.push(s.tdb.prepare("INSERT INTO topics (id, tenant_id, project_id, name, status) VALUES (?2, ?1, ?3, ?4, 'active')", topicId, p.id, topicName.slice(0, 60)));
      }
    }
    stmts.push(
      s.tdb.prepare(
        "INSERT INTO prompts (id, tenant_id, project_id, topic_id, text, country, tags, status) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'active')",
        newId("pr"),
        p.id,
        topicId,
        promptText,
        country,
        JSON.stringify(tags.filter(Boolean).slice(0, 20)),
      ),
    );
    return undefined;
  });
  const promptCount = stmts.length - newTopics.size;
  await activePromptRoom(s, p.id, promptCount);
  for (let i = 0; i < stmts.length; i += 80) await s.tdb.batch(stmts.slice(i, i + 80));
  return c.json({ imported: promptCount, errors });
});

api.patch("/projects/:pid/prompts/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const cur = await s.tdb.first<PromptRow>("SELECT * FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  if (!cur) throw new HttpError(404, "not_found", "Prompt not found");
  const b = await body<{ status?: string; text?: string; tags?: string[]; topic_id?: string | null; intent?: string; branded?: boolean; country?: string }>(c);
  if (b.status === "rejected") {
    // A rejected suggestion is removed; a prompt with history is archived so past reports stay intact.
    const used = await s.tdb.first<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ?1 AND prompt_id = ?2", cur.id);
    if (used?.n) await s.tdb.run("UPDATE prompts SET status = 'archived' WHERE tenant_id = ?1 AND id = ?2", cur.id);
    else await s.tdb.run("DELETE FROM prompts WHERE tenant_id = ?1 AND id = ?2", cur.id);
    return c.json({ ok: true, deleted: !used?.n });
  }
  const status = b.status && ["suggested", "active", "archived"].includes(b.status) ? b.status : cur.status;
  if (status === "active" && cur.status !== "active") await activePromptRoom(s, p.id, 1);
  const country = b.country ? String(b.country).toUpperCase() : cur.country;
  if (!COUNTRY.test(country)) throw new HttpError(400, "bad_request", "country must be an ISO-2 code");
  await s.tdb.run(
    "UPDATE prompts SET status = ?4, text = ?5, tags = ?6, topic_id = ?7, intent = ?8, branded = ?9, country = ?10 WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3",
    p.id,
    cur.id,
    status,
    b.text ? str(b.text, 200, "text") : cur.text,
    b.tags ? JSON.stringify(strList(b.tags, 20, 40)) : cur.tags,
    b.topic_id === undefined ? cur.topic_id : b.topic_id,
    b.intent && INTENTS.includes(b.intent) ? b.intent : cur.intent,
    b.branded === undefined ? cur.branded : b.branded ? 1 : 0,
    country,
  );
  return c.json(promptOut((await s.tdb.first<PromptRow>("SELECT * FROM prompts WHERE tenant_id = ?1 AND id = ?2", cur.id))!));
});

api.delete("/projects/:pid/prompts/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  // Archive rather than delete when the prompt already has history, so past reports stay intact.
  const used = await s.tdb.first<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ?1 AND prompt_id = ?2", c.req.param("id"));
  if (used?.n) await s.tdb.run("UPDATE prompts SET status = 'archived' WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  else await s.tdb.run("DELETE FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  return c.json({ ok: true, archived: !!used?.n });
});

// ------------------------------------------------------------------ brands

function brandOut(r: BrandRow) {
  return {
    id: r.id,
    name: r.name,
    aliases: parseJson<string[]>(r.aliases, []),
    domains: parseJson<string[]>(r.domains, []),
    socials: parseJson<string[]>(r.socials, []),
    regex: r.regex,
    is_own: !!r.is_own,
    status: r.status,
    color: r.color,
  };
}

api.get("/projects/:pid/brands", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const rows = await s.tdb.all<BrandRow>("SELECT * FROM brands WHERE tenant_id = ?1 AND project_id = ?2 ORDER BY is_own DESC, status, name", p.id);
  return c.json(rows.map(brandOut));
});

api.post("/projects/:pid/brands", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ name?: string; aliases?: string[]; domains?: string[]; socials?: string[]; regex?: string; is_own?: boolean; color?: string }>(c);
  if (b.regex) validateRegex(b.regex);
  const id = newId("br");
  await s.tdb.run(
    "INSERT INTO brands (id, tenant_id, project_id, name, aliases, regex, domains, socials, is_own, color) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    id,
    p.id,
    str(b.name, 80, "name"),
    JSON.stringify(strList(b.aliases, 20, 80)),
    b.regex ?? null,
    JSON.stringify(strList(b.domains, 10, 120).map(cleanDomain)),
    JSON.stringify(strList(b.socials, 10, 200)),
    b.is_own ? 1 : 0,
    b.color && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : null,
  );
  return c.json(brandOut((await s.tdb.first<BrandRow>("SELECT * FROM brands WHERE tenant_id = ?1 AND id = ?2", id))!), 201);
});

function validateRegex(r: string) {
  if (r.length > 200) throw new HttpError(400, "bad_request", "Pattern is longer than 200 characters");
  try {
    new RegExp(r, "iu");
  } catch {
    throw new HttpError(400, "bad_request", "That pattern isn't a valid regular expression");
  }
}

api.patch("/projects/:pid/brands/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const cur = await s.tdb.first<BrandRow>("SELECT * FROM brands WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  if (!cur) throw new HttpError(404, "not_found", "Brand not found");
  const b = await body<{ name?: string; aliases?: string[]; domains?: string[]; socials?: string[]; regex?: string | null; status?: string; color?: string }>(c);
  if (b.regex) validateRegex(b.regex);
  await s.tdb.run(
    "UPDATE brands SET name = ?4, aliases = ?5, domains = ?6, socials = ?7, regex = ?8, status = ?9, color = ?10 WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3",
    p.id,
    cur.id,
    b.name ? str(b.name, 80, "name") : cur.name,
    b.aliases ? JSON.stringify(strList(b.aliases, 20, 80)) : cur.aliases,
    b.domains ? JSON.stringify(strList(b.domains, 10, 120).map(cleanDomain)) : cur.domains,
    b.socials ? JSON.stringify(strList(b.socials, 10, 200)) : cur.socials,
    b.regex === undefined ? cur.regex : b.regex,
    b.status && ["active", "suggested", "rejected"].includes(b.status) && !cur.is_own ? b.status : cur.status,
    b.color && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : cur.color,
  );
  return c.json(brandOut((await s.tdb.first<BrandRow>("SELECT * FROM brands WHERE tenant_id = ?1 AND id = ?2", cur.id))!));
});

api.delete("/projects/:pid/brands/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const cur = await s.tdb.first<BrandRow>("SELECT * FROM brands WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  if (cur?.is_own) throw new HttpError(400, "bad_request", "Your own brand can't be removed");
  await s.tdb.run("DELETE FROM brands WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ engines and countries

api.get("/projects/:pid/models", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const enabled = await s.tdb.all<{ engine: string }>("SELECT engine FROM project_models WHERE tenant_id = ?1 AND project_id = ?2 AND enabled = 1", p.id);
  return c.json(engineList(c.env).map((e) => ({ engine: e.id, label: e.label, enabled: enabled.some((x) => x.engine === e.id), available: e.available, channel: e.channel, note: e.note })));
});

api.put("/projects/:pid/models", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ engines?: string[] }>(c);
  const engines = strList(b.engines, 10).filter((e) => ENGINE_IDS.includes(e as never) && getEngine(e)?.channel(c.env) !== "unavailable");
  if (engines.length > s.tenant.model_limit) throw new HttpError(403, "limit", `Your plan tracks up to ${s.tenant.model_limit} engines.`);
  await s.tdb.batch([
    s.tdb.prepare("DELETE FROM project_models WHERE tenant_id = ?1 AND project_id = ?2", p.id),
    ...engines.map((e) => s.tdb.prepare("INSERT INTO project_models (tenant_id, project_id, engine) VALUES (?1, ?2, ?3)", p.id, e)),
  ]);
  return c.json({ engines });
});

api.get("/projects/:pid/countries", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const rows = await s.tdb.all<{ country: string }>("SELECT country FROM project_countries WHERE tenant_id = ?1 AND project_id = ?2 ORDER BY country", p.id);
  return c.json({ countries: rows.map((r) => r.country) });
});

api.put("/projects/:pid/countries", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ countries?: string[] }>(c);
  const countries = [...new Set(strList(b.countries, 30, 2).map((x) => x.toUpperCase()).filter((x) => COUNTRY.test(x)))];
  if (countries.length > s.tenant.country_limit) throw new HttpError(403, "limit", `Your plan covers up to ${s.tenant.country_limit} countries.`);
  await s.tdb.batch([
    s.tdb.prepare("DELETE FROM project_countries WHERE tenant_id = ?1 AND project_id = ?2", p.id),
    ...countries.map((x) => s.tdb.prepare("INSERT INTO project_countries (tenant_id, project_id, country) VALUES (?1, ?2, ?3)", p.id, x)),
  ]);
  return c.json({ countries });
});

// ------------------------------------------------------------------ reports

api.get("/projects/:pid/overview", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  return c.json(await overview(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams)));
});

api.get("/projects/:pid/chats", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const own = (await loadBrands(s.tdb, p.id)).find((b) => b.isOwn);
  const m = c.req.query("mentioned");
  return c.json(
    await chats(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams), {
      ownBrandId: own?.id ?? null,
      mentioned: m === "own" || m === "not_own" ? m : undefined,
      limit: Number(c.req.query("limit") ?? 50),
      cursor: c.req.query("cursor"),
    }),
  );
});

api.get("/projects/:pid/chats/:runId", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const run = await s.tdb.first<Record<string, unknown> & { r2_key: string | null; prompt_id: string }>(
    `SELECT id, prompt_id, engine, model, country, run_date, status, channel, aig_log_id, cost_micros, input_tokens, output_tokens,
            latency_ms, r2_key, judge, answer_excerpt, created_at, finished_at FROM runs WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3`,
    p.id,
    c.req.param("runId"),
  );
  if (!run) throw new HttpError(404, "not_found", "Chat not found");
  const prompt = await s.tdb.first<{ text: string }>("SELECT text FROM prompts WHERE tenant_id = ?1 AND id = ?2", run.prompt_id);
  let answer = "";
  if (run.r2_key && String(run.r2_key).startsWith(`tenants/${s.tenant.id}/`)) {
    const obj = await c.env.ANSWERS.get(String(run.r2_key));
    if (obj) answer = parseJson<{ text?: string }>(await obj.text(), {}).text ?? "";
  }
  const id = String(run.id);
  const [mentions, citations, fanout, claims] = await Promise.all([
    s.tdb.all("SELECT brand_id, brand_name, rank, sentiment, snippet FROM mentions WHERE tenant_id = ?1 AND run_id = ?2 ORDER BY rank", id),
    s.tdb.all("SELECT url, domain, title, kind, position FROM citations WHERE tenant_id = ?1 AND run_id = ?2 ORDER BY position", id),
    s.tdb.all("SELECT query, kind FROM fanout_queries WHERE tenant_id = ?1 AND run_id = ?2", id),
    s.tdb.all("SELECT claim, verdict, kind FROM claims WHERE tenant_id = ?1 AND run_id = ?2", id),
  ]);
  const { r2_key: _k, answer_excerpt, ...runOut } = run;
  // Seeded demo rows keep the whole sample answer in answer_excerpt instead of R2.
  return c.json({ run: runOut, prompt: prompt?.text ?? "", answer_text: answer || String(answer_excerpt ?? ""), mentions, citations, fanout, claims });
});

api.get("/projects/:pid/sources/domains", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const brands = await loadBrands(s.tdb, p.id);
  return c.json({ items: await domainReport(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams), brands, { gap: c.req.query("gap") === "1", limit: 300 }) });
});

api.get("/projects/:pid/sources/urls", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  return c.json({ items: await urlReport(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams), c.req.query("domain")) });
});

api.get("/projects/:pid/prompts/performance", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const own = (await loadBrands(s.tdb, p.id)).find((b) => b.isOwn);
  return c.json({ items: await promptPerformance(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams), own?.id ?? null) });
});

api.get("/projects/:pid/website/pages", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const f = parseFilters(new URL(c.req.url).searchParams);
  const own = (await loadBrands(s.tdb, p.id)).find((b) => b.isOwn);
  return c.json(await pagesReport(s.tdb, p.id, f.from, f.to, own));
});

api.get("/projects/:pid/website/crawlers", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const f = parseFilters(new URL(c.req.url).searchParams);
  return c.json(await crawlerReport(s.tdb, p.id, f.from, f.to));
});

api.get("/projects/:pid/website/referrals", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const f = parseFilters(new URL(c.req.url).searchParams);
  return c.json(await referralReport(s.tdb, p.id, f.from, f.to));
});

api.get("/projects/:pid/perception", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const f = parseFilters(new URL(c.req.url).searchParams, 30);
  const own = (await loadBrands(s.tdb, p.id)).find((b) => b.isOwn);
  const q = (kind: string, extra = "") =>
    s.tdb.all<{ text: string; count: number; verdict?: string }>(
      `SELECT claim AS text, COUNT(*) AS count ${extra} FROM claims
       WHERE tenant_id = ?1 AND brand_id = ?2 AND kind = ?3
         AND run_id IN (SELECT id FROM runs WHERE tenant_id = ?1 AND project_id = ?4 AND run_date BETWEEN ?5 AND ?6)
       GROUP BY lower(claim) ORDER BY count DESC LIMIT 30`,
      own?.id ?? "",
      kind,
      p.id,
      f.from,
      f.to,
    );
  const [attributes, objections, facts] = await Promise.all([q("attribute"), q("objection"), q("fact", ", MAX(verdict) AS verdict")]);
  return c.json({ attributes, objections, facts: facts.map((x) => ({ claim: x.text, verdict: x.verdict, count: x.count })) });
});

api.get("/projects/:pid/insights", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const f = parseFilters(new URL(c.req.url).searchParams, 30);
  const rows = await s.tdb.all<{ evidence: string }>(
    "SELECT id, day, kind, severity, text, evidence FROM insights WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 ORDER BY day DESC, severity DESC",
    p.id,
    f.from,
    f.to,
  );
  return c.json({ items: rows.map((r) => ({ ...r, evidence: parseJson(r.evidence, {}) })) });
});

api.get("/projects/:pid/actions", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const status = c.req.query("status");
  const rows = await s.tdb.all<{ evidence: string }>(
    `SELECT id, kind, title, detail, impact, status, evidence, created_at, done_at, brief IS NOT NULL AS has_brief FROM actions
     WHERE tenant_id = ?1 AND project_id = ?2 ${status ? "AND status = ?3" : ""} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, impact DESC, created_at DESC`,
    ...(status ? [p.id, status] : [p.id]),
  );
  return c.json({ items: rows.map((r) => ({ ...r, evidence: parseJson(r.evidence, {}) })) });
});

api.patch("/projects/:pid/actions/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ status?: string }>(c);
  if (!b.status || !["open", "in_progress", "done", "dismissed"].includes(b.status)) throw new HttpError(400, "bad_request", "Unknown status");
  await s.tdb.run(
    "UPDATE actions SET status = ?4, done_at = CASE WHEN ?4 = 'done' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3",
    p.id,
    c.req.param("id"),
    b.status,
  );
  return c.json({ ok: true });
});

api.post("/projects/:pid/actions/:id/brief", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const a = await s.tdb.first<{ id: string; title: string; detail: string; evidence: string; brief: string | null }>(
    "SELECT id, title, detail, evidence, brief FROM actions WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3",
    p.id,
    c.req.param("id"),
  );
  if (!a) throw new HttpError(404, "not_found", "Action not found");
  if (a.brief) return c.json({ brief: a.brief });
  requireWrite(s);
  const ev = parseJson<{ prompt_id?: string; domain?: string; competitors?: string[] }>(a.evidence, {});
  const brands = await loadBrands(s.tdb, p.id);
  const promptIds = ev.prompt_id ? [ev.prompt_id] : [];
  const prompts = promptIds.length ? await s.tdb.all<{ text: string }>("SELECT text FROM prompts WHERE tenant_id = ?1 AND id = ?2", promptIds[0]) : [];
  const fanout = promptIds.length
    ? await s.tdb.all<{ query: string }>(
        "SELECT DISTINCT f.query FROM fanout_queries f JOIN runs ON runs.id = f.run_id AND runs.tenant_id = ?1 WHERE f.tenant_id = ?1 AND runs.prompt_id = ?2 LIMIT 12",
        promptIds[0],
      )
    : [];
  const sources = promptIds.length
    ? await s.tdb.all<{ url: string }>(
        "SELECT c.url, COUNT(*) AS n FROM citations c JOIN runs ON runs.id = c.run_id AND runs.tenant_id = ?1 WHERE c.tenant_id = ?1 AND runs.prompt_id = ?2 GROUP BY c.url ORDER BY n DESC LIMIT 8",
        promptIds[0],
      )
    : ev.domain
      ? [{ url: `https://${ev.domain}` }]
      : [];
  const brief = await contentBrief(
    c.env,
    {
      brand: brands.find((b) => b.isOwn)?.name ?? p.name,
      title: a.title,
      detail: a.detail,
      prompts: prompts.map((x) => x.text),
      fanout: fanout.map((x) => x.query),
      competitors: ev.competitors ?? brands.filter((b) => !b.isOwn).map((b) => b.name).slice(0, 5),
      sources: sources.map((x) => x.url),
    },
    { tenant: s.tenant.id, project: p.id, engine: "brief" },
  );
  await s.tdb.run("UPDATE actions SET brief = ?3 WHERE tenant_id = ?1 AND id = ?2", a.id, brief);
  return c.json({ brief });
});

// ------------------------------------------------------------------ views and sharing

api.get("/projects/:pid/views", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const rows = await s.tdb.all<{ filters: string; layout: string }>("SELECT id, name, filters, layout, created_at FROM views WHERE tenant_id = ?1 AND project_id = ?2 ORDER BY created_at DESC", p.id);
  return c.json(rows.map((r) => ({ ...r, filters: parseJson(r.filters, {}), layout: parseJson(r.layout, []) })));
});

api.post("/projects/:pid/views", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  const b = await body<{ name?: string; filters?: unknown; layout?: unknown }>(c);
  const id = newId("view");
  await s.tdb.run(
    "INSERT INTO views (id, tenant_id, project_id, name, filters, layout, created_by) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)",
    id,
    p.id,
    str(b.name, 80, "name"),
    JSON.stringify(b.filters ?? {}).slice(0, 4000),
    JSON.stringify(b.layout ?? []).slice(0, 4000),
    s.email,
  );
  return c.json({ id, name: b.name, filters: b.filters ?? {}, layout: b.layout ?? [] }, 201);
});

api.delete("/projects/:pid/views/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  const p = await s.tdb.project(c.req.param("pid"));
  await s.tdb.run("DELETE FROM views WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  return c.json({ ok: true });
});

api.post("/projects/:pid/views/:id/share", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  if (!c.env.SHARE_LINK_SECRET) throw new HttpError(503, "not_configured", "Set SHARE_LINK_SECRET to enable share links.");
  const p = await s.tdb.project(c.req.param("pid"));
  const view = await s.tdb.first("SELECT id FROM views WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3", p.id, c.req.param("id"));
  if (!view) throw new HttpError(404, "not_found", "View not found");
  const b = await body<{ days?: number }>(c).catch(() => ({ days: 30 }));
  const days = Math.min(Math.max(Number(b.days ?? 30), 1), 365);
  const expires = new Date(Date.now() + days * 86_400_000);
  const shareId = newId("shr");
  await s.tdb.run("INSERT INTO share_links (id, tenant_id, view_id, expires_at) VALUES (?2, ?1, ?3, ?4)", shareId, c.req.param("id"), expires.toISOString());
  const token = await signShare(c.env.SHARE_LINK_SECRET, shareId, expires);
  await audit(s, "share.create", { view: c.req.param("id"), expires: expires.toISOString() });
  return c.json({ url: `${appOrigin(c.env, c.req.raw)}/app/#/shared/${token}`, expires_at: expires.toISOString() });
});

// ------------------------------------------------------------------ exports

api.get("/projects/:pid/export/chats.csv", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const own = (await loadBrands(s.tdb, p.id)).find((b) => b.isOwn);
  const res = await chats(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams), { ownBrandId: own?.id ?? null, limit: 200 });
  const rows = res.items.map((i) => ({
    date: i.run_date,
    engine: i.engine,
    country: i.country,
    prompt: i.prompt,
    channel: i.channel,
    own_rank: i.mentions.find((m) => m.brand_id === own?.id)?.rank ?? "",
    brands: i.mentions.map((m) => `${m.rank}. ${m.brand_name}`).join(" | "),
    citations: i.citations_count,
    excerpt: i.excerpt,
  }));
  return new Response(toCsv(rows, ["date", "engine", "country", "prompt", "channel", "own_rank", "brands", "citations", "excerpt"]), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="chats-${p.id}.csv"` },
  });
});

api.get("/projects/:pid/export/metrics.csv", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const ov = await overview(s.tdb, p.id, parseFilters(new URL(c.req.url).searchParams));
  const rows = ov.leaderboard.map((l) => ({ brand: l.name, own: l.is_own ? "yes" : "", visibility: l.visibility, share_of_voice: l.share_of_voice, position: l.position ?? "", sentiment: l.sentiment ?? "", win_rate: l.win_rate ?? "" }));
  return new Response(toCsv(rows, ["brand", "own", "visibility", "share_of_voice", "position", "sentiment", "win_rate"]), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="metrics-${p.id}-${ov.range.from}-${ov.range.to}.csv"` },
  });
});

// ------------------------------------------------------------------ tracking setup

api.get("/projects/:pid/tracking", async (c) => {
  const s = c.get("session");
  const p = await s.tdb.project(c.req.param("pid"));
  const origin = appOrigin(c.env, c.req.raw);
  return c.json({
    ingest_endpoint: `${origin}/ingest`,
    tap_snippet: `<script async src="${origin}/tap.js" data-project="${p.id}" data-key="YOUR_INGEST_KEY"></script>`,
    edge_worker: {
      repo_path: "edge/",
      vars: { INGEST_URL: `${origin}/ingest/edge`, PROJECT_ID: p.id, INGEST_KEY: "(secret) an API key with scope ingest" },
      route: `${p.domain}/*`,
    },
    sgtm: { endpoint: `${origin}/ingest/conversion`, headers: { "content-type": "application/json", "x-ingest-key": "YOUR_INGEST_KEY" }, project_id: p.id },
  });
});

export { api as portalApi };

// ------------------------------------------------------------------ public share (no auth)

export const sharedApi = new Hono<{ Bindings: Env }>();

sharedApi.get("/:token", async (c) => {
  if (!c.env.SHARE_LINK_SECRET) throw new HttpError(404, "not_found", "Link not found");
  const shareId = await verifyShare(c.env.SHARE_LINK_SECRET, c.req.param("token"));
  if (!shareId) throw new HttpError(404, "not_found", "This link has expired or isn't valid.");
  const link = await c.env.DB.prepare("SELECT tenant_id, view_id, revoked_at, expires_at FROM share_links WHERE id = ?1")
    .bind(shareId)
    .first<{ tenant_id: string; view_id: string; revoked_at: string | null; expires_at: string }>();
  if (!link || link.revoked_at || link.expires_at < nowIso()) throw new HttpError(404, "not_found", "This link has expired or isn't valid.");
  const tdb = new TenantDB(c.env.DB, link.tenant_id);
  const view = await tdb.first<{ id: string; name: string; project_id: string; filters: string; layout: string }>(
    "SELECT id, name, project_id, filters, layout FROM views WHERE tenant_id = ?1 AND id = ?2",
    link.view_id,
  );
  if (!view) throw new HttpError(404, "not_found", "This view was deleted.");
  const project: ProjectRow = await tdb.project(view.project_id);
  const saved = parseJson<Record<string, string>>(view.filters, {});
  const q = new URLSearchParams();
  for (const k of ["engine", "country", "topic", "tag"]) if (saved[k]) q.set(k, String(saved[k]));
  // A shared view always shows the latest window of the saved length.
  const days = Number(saved.days ?? 14) || 14;
  q.set("to", today());
  q.set("from", addDays(today(), -(days - 1)));
  const ov = await overview(tdb, project.id, parseFilters(q));
  return c.json({
    view: { name: view.name, filters: saved, layout: parseJson(view.layout, []) },
    project: { name: project.name, domain: project.domain },
    overview: { ...ov, recent_chats: [], actions: [] },
  });
});
