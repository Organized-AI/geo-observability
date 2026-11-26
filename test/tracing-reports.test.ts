/** G6: reports in each person's own day, morning emails, and the stop link. */
import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { TenantDB } from "../src/lib/db";
import { localDayRange, localNow, offsetMinutes, validZone } from "../src/tracing/localday";
import { generatePeopleReports } from "../src/tracing/people";
import { deliverReports, reportMail, unsubscribeToken } from "../src/tracing/report-mail";

const env = rawEnv as unknown as Env;
const SLUG = "trace-reports";
let tenantId = "";
let key = "";

const str = (k: string, v: string) => ({ key: k, value: { stringValue: v } });
function turn(traceId: string, user: string, startMs: number, tz: string) {
  return {
    resourceSpans: [{ resource: { attributes: [str("service.name", "claude-code")] }, scopeSpans: [{ spans: [{
      traceId, spanId: traceId.slice(0, 16), name: "turn", startTimeUnixNano: `${startMs}000000`, endTimeUnixNano: `${startMs + 5000}000000`,
      attributes: [str("openinference.span.kind", "AGENT"), str("harness.name", "claude-code"), str("user.id", user), str("user.timezone", tz), str("input.value", "hi")],
    }] }] }],
  };
}
const send = (payload: unknown) =>
  SELF.fetch("https://geo.test/ingest/otlp/v1/traces", { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": key }, body: JSON.stringify(payload) });
const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://geo.test${path}`, { method, headers: { "content-type": "application/json", "x-tenant": SLUG }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  tenantId = ((await (await call("POST", "/api/tenants", { name: "Trace Reports", slug: SLUG })).json()) as { id: string }).id;
  key = ((await (await call("POST", "/api/keys", { name: "r", scope: "ingest" })).json()) as { secret: string }).secret;
});

describe("local days", () => {
  it("knows offsets, including across a clock change", () => {
    expect(validZone("America/Chicago")).toBe("America/Chicago");
    expect(validZone("Mars/Olympus")).toBeNull();
    expect(offsetMinutes("America/Chicago", Date.UTC(2026, 0, 15, 12))).toBe(-360);
    expect(offsetMinutes("America/Chicago", Date.UTC(2026, 6, 15, 12))).toBe(-300);
    expect(offsetMinutes("Asia/Kolkata", Date.UTC(2026, 6, 15, 12))).toBe(330);
    const r = localDayRange("2026-07-15", "America/Chicago");
    expect(new Date(r.from).toISOString()).toBe("2026-07-15T05:00:00.000Z");
    expect(new Date(r.to + 1).toISOString()).toBe("2026-07-16T05:00:00.000Z");
    // The day clocks go back is 25 hours long.
    const fallBack = localDayRange("2026-11-01", "America/Chicago");
    expect((fallBack.to + 1 - fallBack.from) / 3_600_000).toBe(25);
    expect(localNow("America/Chicago", Date.UTC(2026, 6, 16, 3))).toEqual({ day: "2026-07-15", hour: 22 });
  });
});

describe("reports in each person's own day, and the morning email", () => {
  // 10pm in Chicago on Jul 15 is already Jul 16 in UTC; it belongs to the person's Jul 15.
  const lateEvening = Date.UTC(2026, 6, 16, 3, 0);

  it("counts a late-evening turn in the person's own day", async () => {
    expect((await send(turn("d".repeat(32), "chi@reports.test", lateEvening, "America/Chicago"))).status).toBe(200);
    const tz = await env.DB.prepare("SELECT tz FROM trace_people WHERE tenant_id = ?1 AND user_id = ?2").bind(tenantId, "chi@reports.test").first<{ tz: string }>();
    expect(tz!.tz).toBe("America/Chicago");
    const tdb = new TenantDB(env.DB, tenantId);
    // Next day, 9am Chicago (14:00 UTC): yesterday there is Jul 15.
    expect(await generatePeopleReports(tdb, Date.UTC(2026, 6, 16, 14))).toBe(1);
    const row = await env.DB.prepare("SELECT day, report FROM trace_reports WHERE tenant_id = ?1 AND user_id = ?2").bind(tenantId, "chi@reports.test").first<{ day: string; report: string }>();
    expect(row!.day).toBe("2026-07-15");
    expect(JSON.parse(row!.report)).toMatchObject({ tz: "America/Chicago", totals: { turns: 1 } });
  });

  it("builds an unstored day in the person's own time zone", async () => {
    const { getReport } = await import("../src/tracing/people");
    await env.DB.prepare("DELETE FROM trace_reports WHERE tenant_id = ?1").bind(tenantId).run();
    const r = await getReport(new TenantDB(env.DB, tenantId), "chi@reports.test", "2026-07-15");
    expect(r).toMatchObject({ stored: false, tz: "America/Chicago", totals: { turns: 1 } });
    expect(await getReport(new TenantDB(env.DB, tenantId), "chi@reports.test", "2026-07-16")).toBeNull();
    await generatePeopleReports(new TenantDB(env.DB, tenantId), Date.UTC(2026, 6, 16, 14));
  });

  it("emails nobody until an owner turns it on, then sends each person theirs once", async () => {
    const tdb = new TenantDB(env.DB, tenantId);
    const outbox = () => env.DB.prepare("SELECT to_email, subject, text FROM email_outbox WHERE to_email = 'chi@reports.test'").all<{ to_email: string; subject: string; text: string }>();
    expect(await deliverReports(env, tdb, Date.UTC(2026, 6, 16, 14))).toBe(0);
    expect((await call("PUT", "/api/tracing/settings", { email_reports: true })).status).toBe(200);
    // 6am in Chicago is too early.
    expect(await deliverReports(env, tdb, Date.UTC(2026, 6, 16, 11))).toBe(0);
    expect(await deliverReports(env, tdb, Date.UTC(2026, 6, 16, 14))).toBe(1);
    expect(await deliverReports(env, tdb, Date.UTC(2026, 6, 16, 15))).toBe(0);
    const mails = (await outbox()).results;
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("2026-07-15");
    expect(mails[0]!.text).toContain("1 turns");
    expect(mails[0]!.text).toContain("/trace/stop-reports?t=");
    expect(mails[0]!.text).toContain("/app/#/traces/person/chi%40reports.test");
  });

  it("stops a person's emails from the link, only by pressing the button", async () => {
    const t = await unsubscribeToken(env.SHARE_LINK_SECRET!, tenantId, "chi@reports.test");
    const page = await SELF.fetch(`https://geo.test/trace/stop-reports?t=${encodeURIComponent(t)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Stop the emails");
    const before = await env.DB.prepare("SELECT email_reports FROM trace_people WHERE tenant_id = ?1 AND user_id = ?2").bind(tenantId, "chi@reports.test").first<{ email_reports: number }>();
    expect(before!.email_reports).toBe(1);
    const res = await SELF.fetch("https://geo.test/trace/stop-reports", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` });
    expect(await res.text()).toContain("won't get daily report emails");
    const after = await env.DB.prepare("SELECT email_reports FROM trace_people WHERE tenant_id = ?1 AND user_id = ?2").bind(tenantId, "chi@reports.test").first<{ email_reports: number }>();
    expect(after!.email_reports).toBe(0);
    expect(await (await SELF.fetch("https://geo.test/trace/stop-reports?t=forged.123.abc")).text()).toContain("expired");
  });

  it("writes a plain email with the day's numbers and what to look at", () => {
    const m = reportMail("GEO", "a@b.test", {
      user_id: "a@b.test", day: "2026-07-15", tz: "Europe/Paris",
      totals: { turns: 12, sessions: 3, total_tokens: 2_400_000 } as never,
      usual: { active_days: 5, turns_per_day: 10, tokens_per_day: 1_000_000, tool_failure_rate: 0 },
      apps: [{ name: "claude-code", calls: 12 }], top_tools: [], skills: [{ name: "review", calls: 2 }], plugins: [], mcp_servers: [], subagents: [], programs: [], models: [], projects: [],
      observations: [{ level: "tip", title: "Try a skill", detail: "It saves steps." }],
    }, "https://x/app", "https://x/stop");
    expect(m.text).toContain("Your coding tools on 2026-07-15 (Europe/Paris)");
    expect(m.text).toContain("12 turns in 3 sessions, 2.4M tokens.");
    expect(m.text).toContain("Skills: review (2)");
    expect(m.text).toContain("- Try: Try a skill. It saves steps.");
  });
});
