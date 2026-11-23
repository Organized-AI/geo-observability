/**
 * Builds the SQL for the read-only demo workspace: a fictional brand, four fictional competitors,
 * 30 days of sample answers from the stub engine, plus sample crawler, referral and conversion data,
 * insights and actions, and sample LLM traces. Every run is stored with channel = 'stub', so the portal labels it as sample data.
 */
import { rng, stubAnswer } from "../../src/engines/stub";
import { classifyDomain, findMentions, type BrandMatcher } from "../../src/judge/mentions";
import { canonicalUrl, domainOf, pathOf } from "../../src/lib/util";
import { demoTraces } from "./traces";

const q = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export function generate(days = 30, endDay = new Date().toISOString().slice(0, 10)): string {
  const T = "ten_demo";
  const P = "prj_demo";
  const out: string[] = ["PRAGMA foreign_keys = OFF;"];
  for (const t of ["llm_spans", "llm_traces", "trace_apps", "mentions", "citations", "fanout_queries", "claims", "runs", "daily_brand_metrics", "crawl_daily", "referral_daily", "conversion_daily", "insights", "actions", "prompts", "topics", "brands", "project_models", "project_countries", "brand_profiles", "projects", "domain_classes", "usage_events"]) {
    out.push(`DELETE FROM ${t} WHERE tenant_id = '${T}';`);
  }
  out.push(`DELETE FROM tenants WHERE id = '${T}';`);
  out.push(`INSERT INTO tenants (id, name, slug, plan, prompt_limit, project_limit, model_limit, country_limit) VALUES ('${T}', 'Demo workspace', 'demo', 'pro', 150, 2, 4, 3);`);
  out.push(`INSERT INTO projects (id, tenant_id, name, domain, schedule, onboarding_step) VALUES ('${P}', '${T}', 'Northwind Desk', 'northwind-desk.example', 'paused', 'done');`);
  out.push(
    `INSERT INTO brand_profiles (project_id, tenant_id, what_you_sell, buyers, markets, facts) VALUES ('${P}', '${T}', ${q("Help desk and customer support software for small and mid-sized teams.")}, ${q("Support leads and operations managers at companies with 5 to 200 agents.")}, ${q(JSON.stringify([{ country: "US", language: "en" }, { country: "GB", language: "en" }]))}, ${q(JSON.stringify(["Has a free plan for up to 3 agents", "Integrates with Slack and Shopify", "Founded in 2019"]))});`,
  );

  const brands: (BrandMatcher & { color: string })[] = [
    { id: "br_demo_own", name: "Northwind Desk", aliases: ["Northwind"], regex: null, domains: ["northwind-desk.example"], isOwn: true, color: "#0E8A7E" },
    { id: "br_demo_c1", name: "Tailspin Support", aliases: ["Tailspin"], regex: null, domains: ["tailspin-support.example"], isOwn: false, color: "#C2562F" },
    { id: "br_demo_c2", name: "Contoso Helpdesk", aliases: ["Contoso"], regex: null, domains: ["contoso-helpdesk.example"], isOwn: false, color: "#5B5BD6" },
    { id: "br_demo_c3", name: "Fabrikam Service", aliases: [], regex: null, domains: ["fabrikam-service.example"], isOwn: false, color: "#B5871C" },
    { id: "br_demo_c4", name: "Litware Tickets", aliases: ["Litware"], regex: null, domains: ["litware-tickets.example"], isOwn: false, color: "#2F7FC2" },
  ];
  for (const b of brands) {
    out.push(
      `INSERT INTO brands (id, tenant_id, project_id, name, aliases, domains, is_own, status, color) VALUES (${q(b.id)}, '${T}', '${P}', ${q(b.name)}, ${q(JSON.stringify(b.aliases))}, ${q(JSON.stringify(b.domains))}, ${b.isOwn ? 1 : 0}, 'active', ${q(b.color)});`,
    );
  }
  out.push(`INSERT INTO brands (id, tenant_id, project_id, name, status) VALUES ('br_demo_s1', '${T}', '${P}', 'Proseware Assist', 'suggested');`);

  const topics = [
    ["top_demo_1", "help desk software"],
    ["top_demo_2", "customer support tools"],
    ["top_demo_3", "ticketing for ecommerce"],
    ["top_demo_4", "help desk pricing"],
  ];
  for (const [id, name] of topics) out.push(`INSERT INTO topics (id, tenant_id, project_id, name, status) VALUES ('${id}', '${T}', '${P}', ${q(name)}, 'active');`);

  const prompts: [string, string, string, string, string[]][] = [
    ["What is the best help desk software for a small team?", "top_demo_1", "commercial", "US", ["core"]],
    ["Which help desk tools integrate with Slack?", "top_demo_1", "commercial", "US", ["integrations"]],
    ["How do I choose a ticketing system for customer support?", "top_demo_1", "informational", "US", []],
    ["Best free help desk software in 2026", "top_demo_4", "commercial", "US", ["pricing"]],
    ["Cheapest help desk with a shared inbox", "top_demo_4", "transactional", "US", ["pricing"]],
    ["What customer support software do Shopify stores use?", "top_demo_3", "commercial", "US", ["ecommerce"]],
    ["Ticketing system for an online store with returns", "top_demo_3", "commercial", "US", ["ecommerce"]],
    ["How can a small team handle support emails better?", "top_demo_2", "informational", "US", []],
    ["Alternatives to big enterprise help desks for startups", "top_demo_2", "commercial", "US", ["core"]],
    ["Is Northwind Desk good for a 10-person support team?", "top_demo_1", "commercial", "US", ["branded"]],
    ["Northwind Desk vs Tailspin Support", "top_demo_1", "commercial", "US", ["branded"]],
    ["Which help desk has the best reporting?", "top_demo_2", "commercial", "US", []],
    ["Help desk software with AI reply suggestions", "top_demo_2", "commercial", "US", ["ai"]],
    ["Best help desk for UK small businesses", "top_demo_1", "commercial", "GB", ["core"]],
    ["Customer service software pricing comparison", "top_demo_4", "commercial", "GB", ["pricing"]],
    ["Sign up for a help desk with a free trial", "top_demo_4", "transactional", "US", []],
    ["What features matter most in a ticketing tool?", "top_demo_2", "informational", "US", []],
    ["Help desk that works with Shopify and Slack", "top_demo_3", "commercial", "US", ["integrations", "ecommerce"]],
    ["How to set up SLAs in a support team", "top_demo_2", "informational", "GB", []],
    ["Top rated support ticket software for agencies", "top_demo_1", "commercial", "US", []],
  ];
  prompts.forEach(([text, topic, intent, country, tags], i) => {
    out.push(
      `INSERT INTO prompts (id, tenant_id, project_id, topic_id, text, country, intent, branded, tags, status, volume, created_at) VALUES ('pr_demo_${i}', '${T}', '${P}', '${topic}', ${q(text)}, '${country}', '${intent}', ${/Northwind/.test(text) ? 1 : 0}, ${q(JSON.stringify(tags))}, 'active', ${1 + (i % 5)}, '2026-01-01T00:00:${String(i).padStart(2, "0")}Z');`,
    );
  });
  for (const e of ["chatgpt", "claude", "gemini", "perplexity"]) out.push(`INSERT INTO project_models (tenant_id, project_id, engine) VALUES ('${T}', '${P}', '${e}');`);
  for (const c of ["US", "GB"]) out.push(`INSERT INTO project_countries (tenant_id, project_id, country) VALUES ('${T}', '${P}', '${c}');`);

  const engines = ["chatgpt", "claude", "gemini", "perplexity"] as const;
  const dayList: string[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const dt = new Date(`${endDay}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - d);
    dayList.push(dt.toISOString().slice(0, 10));
  }
  const ownPaths = new Map<string, number>();
  dayList.forEach((day, di) => {
    for (const [pi, [text, , , country]] of prompts.entries()) {
      for (const engine of engines) {
        const runId = `pr_demo_${pi}:${engine}:${country}:${day}`;
        // Visibility trends up over the month so the demo has a story to tell.
        const boost = di / days;
        const ctxBrands = brands.map((b) => ({ name: b.name, domains: b.domains, isOwn: b.isOwn && rng(runId)() < 0.55 + boost * 0.3 }));
        const ans = stubAnswer(engine, text, { env: {} as never, tenantId: T, projectId: P, promptId: `pr_demo_${pi}`, runId, country, language: "en", brands: ctxBrands });
        const fixedText = ans.text;
        const mentions = findMentions(fixedText, brands, text);
        const cost = 1500 + Math.floor(rng(`${runId}c`)() * 4000);
        out.push(
          `INSERT INTO runs (id, tenant_id, project_id, prompt_id, engine, model, country, run_date, status, channel, cost_micros, input_tokens, output_tokens, latency_ms, answer_excerpt, judge, finished_at) VALUES (${q(runId)}, '${T}', '${P}', 'pr_demo_${pi}', '${engine}', ${q(`stub-${engine}`)}, '${country}', '${day}', 'done', 'stub', ${cost}, 0, 0, ${800 + Math.floor(rng(runId)() * 4000)}, ${q(fixedText)}, 'rules', '${day}T06:10:00Z');`,
        );
        for (const m of mentions) {
          out.push(`INSERT INTO mentions (run_id, tenant_id, brand_id, brand_name, rank, sentiment, snippet) VALUES (${q(runId)}, '${T}', ${q(m.brandId)}, ${q(m.brandName)}, ${m.rank}, ${Math.round(m.sentiment)}, ${q(m.snippet)});`);
        }
        ans.citations.forEach((c, i) => {
          const url = canonicalUrl(c.url);
          const domain = domainOf(url);
          if (!domain) return;
          out.push(
            `INSERT OR IGNORE INTO citations (run_id, tenant_id, url, domain, path, title, kind, position) VALUES (${q(runId)}, '${T}', ${q(url)}, ${q(domain)}, ${q(pathOf(url))}, ${q(c.title ?? null)}, '${c.kind}', ${i + 1});`,
          );
          out.push(`INSERT OR IGNORE INTO domain_classes (tenant_id, project_id, domain, type) VALUES ('${T}', '${P}', ${q(domain)}, ${q(classifyDomain(domain, brands))});`);
          if (domain === "northwind-desk.example") ownPaths.set(pathOf(url), (ownPaths.get(pathOf(url)) ?? 0) + 1);
        });
        for (const f of ans.fanout) out.push(`INSERT OR IGNORE INTO fanout_queries (run_id, tenant_id, query, kind) VALUES (${q(runId)}, '${T}', ${q(f.query)}, 'search');`);
        if (mentions.some((m) => m.brandId === "br_demo_own") && rng(`${runId}k`)() < 0.25) {
          const claims = [
            ["Offers a free plan for small teams", "fact", "matches"],
            ["Free for up to 10 agents", "fact", "conflicts"],
            ["easy to set up", "attribute", "unchecked"],
            ["strong Shopify integration", "attribute", "unchecked"],
            ["reporting is basic compared with larger tools", "objection", "unchecked"],
          ];
          const [claim, kind, verdict] = claims[Math.floor(rng(`${runId}x`)() * claims.length)];
          out.push(`INSERT INTO claims (run_id, tenant_id, brand_id, claim, verdict, kind) VALUES (${q(runId)}, '${T}', 'br_demo_own', ${q(claim)}, '${verdict}', '${kind}');`);
        }
      }
    }
  });

  // Observability layer sample data for the pages answers cite.
  const paths = [...new Set(["/", "/pricing", "/features", "/blog/guide", "/compare", ...ownPaths.keys()])];
  const bots: [string, string, string][] = [
    ["GPTBot", "openai", "training"],
    ["OAI-SearchBot", "openai", "search"],
    ["ChatGPT-User", "openai", "user"],
    ["ClaudeBot", "anthropic", "training"],
    ["Claude-User", "anthropic", "user"],
    ["PerplexityBot", "perplexity", "search"],
    ["Perplexity-User", "perplexity", "user"],
  ];
  dayList.forEach((day, di) => {
    for (const path of paths) {
      const r = rng(`${day}${path}`);
      const weight = path === "/pricing" ? 3 : path === "/" ? 2 : 1;
      for (const [bot, op, type] of bots) {
        // /features stops being fetched in the last week: the demo's "crawl drop" insight.
        if (path === "/features" && di >= days - 7 && type !== "training") continue;
        const hits = Math.floor(r() * 6 * weight * (type === "user" ? 1.5 : 1));
        if (hits) out.push(`INSERT INTO crawl_daily (tenant_id, project_id, day, path, bot, operator, bot_type, hits, status_4xx) VALUES ('${T}', '${P}', '${day}', ${q(path)}, '${bot}', '${op}', '${type}', ${hits}, 0);`);
      }
      for (const a of ["chatgpt", "perplexity", "claude", "gemini"]) {
        const sessions = Math.floor(r() * 5 * weight * (1 + di / days) * (a === "chatgpt" ? 2 : 1));
        if (sessions) out.push(`INSERT INTO referral_daily (tenant_id, project_id, day, path, assistant, source, sessions) VALUES ('${T}', '${P}', '${day}', ${q(path)}, '${a}', 'edge', ${sessions});`);
        if (sessions > 4 && r() < 0.5) {
          const conv = 1 + Math.floor(r() * 2);
          out.push(
            `INSERT INTO conversion_daily (tenant_id, project_id, day, path, assistant, source, event_name, conversions, value_micros, currency) VALUES ('${T}', '${P}', '${day}', ${q(path)}, '${a}', 'sgtm', 'trial_start', ${conv}, ${conv * 49_000_000}, 'USD');`,
          );
        }
      }
    }
  });

  const today = dayList[dayList.length - 1];
  const insights: [string, number, string][] = [
    ["visibility_move", 2, "Northwind Desk appeared in more answers this week than last, led by gains on Perplexity and ChatGPT."],
    ["rival_source", 2, "A few review and community sites now feed answers that recommend Tailspin Support and Contoso Helpdesk but not you."],
    ["crawl_drop", 2, "/features is no longer being fetched by AI search or user agents this week, though answers cited it earlier in the month."],
    ["conversion_move", 2, "Visitors arriving from AI assistants started more trials this week, mostly landing on /pricing."],
    ["fact_conflict", 1, "Some answers say Northwind Desk is free for up to 10 agents; your profile says the free plan covers 3."],
  ];
  insights.forEach(([kind, sev, text], i) => out.push(`INSERT INTO insights (id, tenant_id, project_id, day, kind, severity, text, evidence) VALUES ('ins_demo_${i}', '${T}', '${P}', '${today}', '${kind}', ${sev}, ${q(text)}, '{"sample":true}');`));
  const actions: [string, string, string, number][] = [
    ["get_listed", "Get covered on g2.com", "This review site fed answers that named competitors but not Northwind Desk.", 3],
    ["new_page", 'Answer "Which help desk has the best reporting?" on your site', "None of the recent answers to this prompt named Northwind Desk.", 2],
    ["fix_crawl", "Check AI crawler access to /features", "Answers cited this page, but AI search and user agents stopped fetching it.", 2],
    ["fix_fact", "Correct a claim assistants repeat about you", 'Answers said "Free for up to 10 agents", which conflicts with your brand profile.', 2],
  ];
  actions.forEach(([kind, title, detail, impact], i) =>
    out.push(`INSERT INTO actions (id, tenant_id, project_id, kind, title, detail, evidence, impact) VALUES ('act_demo_${i}', '${T}', '${P}', '${kind}', ${q(title)}, ${q(detail)}, '{"sample":true}', ${impact});`),
  );
  out.push(...demoTraces(T, dayList));
  out.push("PRAGMA foreign_keys = ON;");
  return out.join("\n") + "\n";
}
