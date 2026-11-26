/**
 * One person's usage in detail, and the daily report built from it.
 *
 * Everything here is counted from stored spans: tool spans carry the tool's name and, from the geo-trace script,
 * the names of the skill, plugin, MCP server, subagent type or shell program involved. Inputs are never needed.
 */
import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { addDays, isDay, parseJson, today } from "../lib/util";
import { localDayRange, localNow, validZone } from "./localday";

const DAY_MS = 86_400_000;
const attr = (key: string) => `json_extract(s.attributes, '$."${key}"')`;

export interface NameCount {
  name: string;
  calls: number;
  failures?: number;
  avg_ms?: number;
  tokens?: number;
}

export interface PersonSummary {
  user_id: string;
  from_ms: number;
  to_ms: number;
  totals: {
    turns: number;
    sessions: number;
    active_days: number;
    failed_turns: number;
    unfinished_turns: number;
    avg_turn_ms: number;
    longest_turn_ms: number;
    model_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    largest_prompt_tokens: number;
    max_model_calls_in_turn: number;
    tool_calls: number;
    tool_failures: number;
    cost_micros: number;
  };
  days: { day: string; turns: number; tokens: number; tool_calls: number }[];
  apps: NameCount[];
  tools: (NameCount & { kind: string })[];
  skills: NameCount[];
  plugins: NameCount[];
  mcp_servers: NameCount[];
  subagents: NameCount[];
  programs: NameCount[];
  commands: NameCount[];
  models: NameCount[];
  projects: NameCount[];
  sessions: { session_id: string; app: string; turns: number; tokens: number; start_ms: number; end_ms: number; errors: number }[];
}

/** Server-side reading of a tool's name, so traces from any sender (and older ones) are still grouped. */
export function toolKind(name: string): { kind: string; server?: string; plugin?: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const plugin = /^plugin_([^_]+(?:-[^_]+)*)_(.+)$/.exec(mcp[1] as string);
    return plugin ? { kind: "mcp", server: plugin[2], plugin: plugin[1] } : { kind: "mcp", server: mcp[1] };
  }
  if (name === "Skill") return { kind: "skill" };
  if (name === "Agent" || name === "Task") return { kind: "subagent" };
  if (/^(Bash|shell|local_shell|exec_command|shell_command)$/i.test(name)) return { kind: "shell" };
  return { kind: "builtin" };
}

const bump = (map: Map<string, NameCount>, name: string, calls: number, failures = 0) => {
  const cur = map.get(name) ?? { name, calls: 0, failures: 0 };
  cur.calls += calls;
  cur.failures = (cur.failures ?? 0) + failures;
  map.set(name, cur);
};
const top = (map: Map<string, NameCount>, n = 30) => [...map.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, n);

export async function personSummary(tdb: TenantDB, userId: string, fromMs: number, toMs: number): Promise<PersonSummary> {
  const where = "s.tenant_id = ?1 AND s.user_id = ?2 AND s.start_ms >= ?3 AND s.start_ms <= ?4";
  const tw = "t.tenant_id = ?1 AND t.user_id = ?2 AND t.start_ms >= ?3 AND t.start_ms <= ?4";
  const [traceTotals, days, apps, sessions, llm, models, toolRows, named, roots] = await Promise.all([
    tdb.first<Record<string, number>>(
      `SELECT COUNT(*) AS turns, COUNT(DISTINCT t.session_id) AS sessions, COUNT(DISTINCT strftime('%Y-%m-%d', t.start_ms / 1000, 'unixepoch')) AS active_days,
              COALESCE(SUM(t.status = 'ERROR'), 0) AS failed_turns, COALESCE(ROUND(AVG(t.end_ms - t.start_ms)), 0) AS avg_turn_ms, COALESCE(MAX(t.end_ms - t.start_ms), 0) AS longest_turn_ms,
              COALESCE(SUM(t.llm_count), 0) AS model_calls, COALESCE(MAX(t.llm_count), 0) AS max_model_calls_in_turn, COALESCE(SUM(t.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(t.completion_tokens), 0) AS completion_tokens, COALESCE(SUM(t.total_tokens), 0) AS total_tokens, COALESCE(SUM(t.cost_micros), 0) AS cost_micros
       FROM llm_traces t WHERE ${tw}`,
      userId, fromMs, toMs,
    ),
    tdb.all<{ day: string; turns: number; tokens: number }>(
      `SELECT strftime('%Y-%m-%d', t.start_ms / 1000, 'unixepoch') AS day, COUNT(*) AS turns, COALESCE(SUM(t.total_tokens), 0) AS tokens
       FROM llm_traces t WHERE ${tw} GROUP BY day ORDER BY day`,
      userId, fromMs, toMs,
    ),
    tdb.all<{ name: string; calls: number; tokens: number }>(
      `SELECT a.name AS name, COUNT(*) AS calls, COALESCE(SUM(t.total_tokens), 0) AS tokens FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id WHERE ${tw} GROUP BY a.name ORDER BY calls DESC`,
      userId, fromMs, toMs,
    ),
    tdb.all<PersonSummary["sessions"][number]>(
      `SELECT t.session_id AS session_id, MAX(a.name) AS app, COUNT(*) AS turns, COALESCE(SUM(t.total_tokens), 0) AS tokens, MIN(t.start_ms) AS start_ms, MAX(t.end_ms) AS end_ms, COALESCE(SUM(t.status = 'ERROR'), 0) AS errors
       FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id WHERE ${tw} AND t.session_id IS NOT NULL GROUP BY t.session_id ORDER BY MAX(t.start_ms) DESC LIMIT 25`,
      userId, fromMs, toMs,
    ),
    tdb.first<{ cache_read: number; largest: number }>(
      `SELECT COALESCE(SUM(${attr("llm.token_count.prompt_details.cache_read")}), 0) AS cache_read, COALESCE(MAX(s.prompt_tokens), 0) AS largest
       FROM llm_spans s WHERE ${where} AND s.kind = 'LLM'`,
      userId, fromMs, toMs,
    ),
    tdb.all<{ name: string; calls: number; tokens: number }>(
      `SELECT s.model AS name, COUNT(*) AS calls, COALESCE(SUM(s.total_tokens), 0) AS tokens FROM llm_spans s WHERE ${where} AND s.kind = 'LLM' AND s.model IS NOT NULL GROUP BY s.model ORDER BY tokens DESC LIMIT 20`,
      userId, fromMs, toMs,
    ),
    tdb.all<{ name: string; calls: number; failures: number; avg_ms: number; day: string }>(
      `SELECT s.name AS name, strftime('%Y-%m-%d', s.start_ms / 1000, 'unixepoch') AS day, COUNT(*) AS calls, COALESCE(SUM(s.status_code = 'ERROR'), 0) AS failures, COALESCE(ROUND(AVG(s.end_ms - s.start_ms)), 0) AS avg_ms
       FROM llm_spans s WHERE ${where} AND s.kind = 'TOOL' GROUP BY s.name, day`,
      userId, fromMs, toMs,
    ),
    tdb.all<{ skill: string | null; plugin: string | null; subagent: string | null; program: string | null; calls: number; failures: number }>(
      `SELECT ${attr("skill.name")} AS skill, ${attr("plugin.name")} AS plugin, ${attr("subagent.type")} AS subagent, ${attr("command.program")} AS program,
              COUNT(*) AS calls, COALESCE(SUM(s.status_code = 'ERROR'), 0) AS failures
       FROM llm_spans s WHERE ${where} AND s.kind = 'TOOL'
         AND (${attr("skill.name")} IS NOT NULL OR ${attr("plugin.name")} IS NOT NULL OR ${attr("subagent.type")} IS NOT NULL OR ${attr("command.program")} IS NOT NULL)
       GROUP BY skill, plugin, subagent, program`,
      userId, fromMs, toMs,
    ),
    tdb.all<{ project: string | null; command: string | null; unfinished: number | null; calls: number }>(
      `SELECT ${attr("project.name")} AS project, ${attr("slash.command")} AS command, ${attr("turn.incomplete")} AS unfinished, COUNT(*) AS calls
       FROM llm_spans s WHERE ${where} AND s.parent_span_id IS NULL GROUP BY project, command, unfinished`,
      userId, fromMs, toMs,
    ),
  ]);

  const tools = new Map<string, NameCount & { kind: string; ms: number }>();
  const toolsByDay = new Map<string, number>();
  const servers = new Map<string, NameCount>();
  const plugins = new Map<string, NameCount>();
  let toolCalls = 0;
  let toolFailures = 0;
  for (const r of toolRows) {
    const k = toolKind(r.name);
    const cur = tools.get(r.name) ?? { name: r.name, kind: k.kind, calls: 0, failures: 0, ms: 0 };
    cur.calls += r.calls;
    cur.failures = (cur.failures ?? 0) + r.failures;
    cur.ms += r.avg_ms * r.calls;
    tools.set(r.name, cur);
    toolsByDay.set(r.day, (toolsByDay.get(r.day) ?? 0) + r.calls);
    toolCalls += r.calls;
    toolFailures += r.failures;
    if (k.server) bump(servers, k.server, r.calls, r.failures);
    if (k.plugin) bump(plugins, k.plugin, r.calls, r.failures);
  }
  const skills = new Map<string, NameCount>();
  const subagents = new Map<string, NameCount>();
  const programs = new Map<string, NameCount>();
  const pluginsFromAttrs = new Map<string, NameCount>();
  for (const r of named) {
    if (r.skill) bump(skills, r.skill, r.calls, r.failures);
    if (r.subagent) bump(subagents, r.subagent, r.calls, r.failures);
    if (r.program) bump(programs, r.program, r.calls, r.failures);
    if (r.plugin) bump(pluginsFromAttrs, r.plugin, r.calls, r.failures);
  }
  // A plugin shows up through its MCP tools (read from tool names) or its skills (read from attributes); count each call once.
  for (const [name, c] of pluginsFromAttrs) if (!plugins.has(name) || (plugins.get(name) as NameCount).calls < c.calls) plugins.set(name, c);
  const projects = new Map<string, NameCount>();
  const commands = new Map<string, NameCount>();
  let unfinished = 0;
  for (const r of roots) {
    if (r.project) bump(projects, r.project, r.calls);
    if (r.command) bump(commands, r.command, r.calls);
    if (r.unfinished) unfinished += r.calls;
  }
  const t = traceTotals ?? {};
  return {
    user_id: userId,
    from_ms: fromMs,
    to_ms: toMs,
    totals: {
      turns: t.turns ?? 0, sessions: t.sessions ?? 0, active_days: t.active_days ?? 0, failed_turns: t.failed_turns ?? 0, unfinished_turns: unfinished,
      avg_turn_ms: t.avg_turn_ms ?? 0, longest_turn_ms: t.longest_turn_ms ?? 0, model_calls: t.model_calls ?? 0, prompt_tokens: t.prompt_tokens ?? 0,
      completion_tokens: t.completion_tokens ?? 0, total_tokens: t.total_tokens ?? 0, cache_read_tokens: llm?.cache_read ?? 0, largest_prompt_tokens: llm?.largest ?? 0,
      max_model_calls_in_turn: t.max_model_calls_in_turn ?? 0, tool_calls: toolCalls, tool_failures: toolFailures, cost_micros: t.cost_micros ?? 0,
    },
    days: days.map((d) => ({ ...d, tool_calls: toolsByDay.get(d.day) ?? 0 })),
    apps,
    tools: [...tools.values()].map(({ ms, ...x }) => ({ ...x, avg_ms: x.calls ? Math.round(ms / x.calls) : 0 })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, 40),
    skills: top(skills),
    plugins: top(plugins),
    mcp_servers: top(servers),
    subagents: top(subagents),
    programs: top(programs),
    commands: top(commands),
    models,
    projects: top(projects),
    sessions,
  };
}

// ------------------------------------------------------------------ daily report

export interface Observation {
  level: "good" | "tip" | "watch";
  title: string;
  detail: string;
}

export interface DailyReport {
  user_id: string;
  day: string;
  /** The time zone the day was counted in (the person's own, from their coding tool; UTC when unknown). */
  tz?: string;
  totals: PersonSummary["totals"];
  /** The same numbers per active day over the seven days before, for comparison. Null when there was no activity. */
  usual: { active_days: number; turns_per_day: number; tokens_per_day: number; tool_failure_rate: number } | null;
  apps: NameCount[];
  top_tools: NameCount[];
  skills: NameCount[];
  plugins: NameCount[];
  mcp_servers: NameCount[];
  subagents: NameCount[];
  programs: NameCount[];
  models: NameCount[];
  projects: NameCount[];
  observations: Observation[];
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${Math.round(n * 100)}%`;
const plural = (n: number, word: string, many = `${word}s`) => `${int(n)} ${n === 1 ? word : many}`;
const list = (items: NameCount[], n = 3) => items.slice(0, n).map((i) => i.name).join(", ");

/**
 * Plain observations from one day's numbers, against the person's own previous week. Rules only: every line can be
 * traced to a number on the page. They describe how the tools were used, not how good the work was.
 */
export function observe(day: PersonSummary, week: PersonSummary): Observation[] {
  const t = day.totals;
  const out: Observation[] = [];
  if (!t.turns) return out;
  const usualTurns = week.totals.active_days ? week.totals.turns / week.totals.active_days : 0;

  // Watch: things that cost time.
  for (const tool of day.tools) {
    const failures = tool.failures ?? 0;
    if (tool.calls >= 4 && failures / tool.calls >= 0.25) {
      out.push({ level: "watch", title: `${tool.name} failed ${failures} of ${tool.calls} times`, detail: `A quarter or more of ${tool.name} calls failed. Each failure is a round trip the assistant has to recover from. Open the failed turns to see what it was trying to do; a missing permission, a wrong path or a flaky command is the usual cause.` });
    }
  }
  if (t.unfinished_turns >= 2 && t.unfinished_turns / t.turns >= 0.2) {
    out.push({ level: "watch", title: `${plural(t.unfinished_turns, "turn")} of ${t.turns} were cut short`, detail: "These turns were interrupted or never finished. If the assistant was heading the wrong way, a more specific first prompt or a plan step before it starts editing usually costs less than stopping it midway." });
  }
  if (t.largest_prompt_tokens >= 150_000) {
    out.push({ level: "watch", title: `One model call carried ${int(t.largest_prompt_tokens)} tokens of context`, detail: "The conversation is getting large. Very long contexts make answers slower and can crowd out earlier instructions. Starting a fresh session for a new task, or compacting, keeps it focused." });
  }

  // Tips: things worth trying.
  if (t.max_model_calls_in_turn >= 40) {
    out.push({ level: "tip", title: `The longest turn took ${t.max_model_calls_in_turn} model calls`, detail: "One prompt led to a very long run. Splitting the request into smaller steps, each checked before the next, makes it easier to catch a wrong turn early." });
  }
  if (t.prompt_tokens >= 200_000 && t.cache_read_tokens / t.prompt_tokens < 0.5) {
    out.push({ level: "tip", title: `${pct(t.cache_read_tokens / t.prompt_tokens)} of input was reused from cache`, detail: "Most input was sent fresh instead of being reused. Many short sessions, or changes to what is loaded at the start of each one, lower reuse. Continuing a session for related work raises it." });
  }
  if (t.turns >= 8 && !day.skills.length && !day.subagents.length) {
    out.push({ level: "tip", title: "No skills or subagents were used", detail: `${plural(t.turns, "turn")} ran with built-in tools only. If there are repeated jobs in this work (reviews, releases, a house style), a skill or a subagent for them can save prompts.` });
  }
  const heavyShell = day.programs.find((p) => p.calls >= 15);
  if (heavyShell) {
    out.push({ level: "tip", title: `${heavyShell.name} was run ${heavyShell.calls} times`, detail: `If the same ${heavyShell.name} commands keep being approved by hand, allowing them in settings removes the prompts.` });
  }

  // Good: worth keeping.
  if (t.tool_calls >= 10 && t.tool_failures === 0) out.push({ level: "good", title: `${plural(t.tool_calls, "tool call")} and none failed`, detail: "Every tool call succeeded today." });
  if (day.skills.length) out.push({ level: "good", title: `Used ${plural(day.skills.length, "skill")}`, detail: `${list(day.skills, 5)}.` });
  if (day.subagents.length) out.push({ level: "good", title: `Delegated to ${plural(day.subagents.reduce((n, s) => n + s.calls, 0), "subagent")}`, detail: `Types: ${list(day.subagents, 5)}.` });
  if (t.prompt_tokens >= 200_000 && t.cache_read_tokens / t.prompt_tokens >= 0.85) out.push({ level: "good", title: `${pct(t.cache_read_tokens / t.prompt_tokens)} of input was reused from cache`, detail: "Sessions were continued long enough for earlier context to be reused." });

  // Context: how the day compares with this person's own week.
  if (usualTurns >= 2) {
    const change = (t.turns - usualTurns) / usualTurns;
    if (Math.abs(change) >= 0.4) out.push({ level: "tip", title: `${change > 0 ? "Busier" : "Quieter"} than usual: ${plural(t.turns, "turn")} against about ${Math.round(usualTurns)} a day`, detail: "Compared with the active days in the week before." });
  }
  const order = { watch: 0, tip: 1, good: 2 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level]).slice(0, 8);
}

const dayRange = (day: string) => ({ from: Date.parse(`${day}T00:00:00Z`), to: Date.parse(`${day}T23:59:59.999Z`) });

export async function buildReport(tdb: TenantDB, userId: string, day: string, tz = "UTC"): Promise<DailyReport> {
  const { from, to } = tz === "UTC" ? dayRange(day) : localDayRange(day, tz);
  const [d, week] = await Promise.all([personSummary(tdb, userId, from, to), personSummary(tdb, userId, from - 7 * DAY_MS, from - 1)]);
  const w = week.totals;
  return {
    user_id: userId,
    day,
    tz,
    totals: d.totals,
    usual: w.active_days ? { active_days: w.active_days, turns_per_day: Math.round(w.turns / w.active_days), tokens_per_day: Math.round(w.total_tokens / w.active_days), tool_failure_rate: w.tool_calls ? w.tool_failures / w.tool_calls : 0 } : null,
    apps: d.apps,
    top_tools: d.tools.slice(0, 10),
    skills: d.skills,
    plugins: d.plugins,
    mcp_servers: d.mcp_servers,
    subagents: d.subagents,
    programs: d.programs.slice(0, 10),
    models: d.models,
    projects: d.projects,
    observations: observe(d, week),
  };
}

/** Writes the report for everyone in a workspace who used a coding tool on `day`. Returns how many were written. */
export async function generateTenantReports(tdb: TenantDB, day: string): Promise<number> {
  const { from, to } = dayRange(day);
  const users = await tdb.all<{ user_id: string }>("SELECT DISTINCT t.user_id AS user_id FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id WHERE t.tenant_id = ?1 AND a.kind = 'coding_tool' AND t.user_id IS NOT NULL AND t.start_ms >= ?2 AND t.start_ms <= ?3 LIMIT 2000", from, to);
  for (const u of users) {
    const report = await buildReport(tdb, u.user_id, day);
    await tdb.run(
      "INSERT INTO trace_reports (tenant_id, user_id, day, report) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (tenant_id, user_id, day) DO UPDATE SET report = excluded.report, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      u.user_id, day, JSON.stringify(report),
    );
  }
  return users.length;
}

/**
 * Each person's yesterday, counted in their own time zone. Runs hourly, so a day is written once it has ended
 * where they are and rewritten as late traces arrive. The emailed_at mark survives a rewrite.
 */
export async function generatePeopleReports(tdb: TenantDB, now: number): Promise<number> {
  const people = await tdb.all<{ user_id: string; tz: string | null }>(
    `SELECT DISTINCT t.user_id AS user_id, p.tz AS tz FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id
     LEFT JOIN trace_people p ON p.tenant_id = t.tenant_id AND p.user_id = t.user_id
     WHERE t.tenant_id = ?1 AND a.kind = 'coding_tool' AND t.user_id IS NOT NULL AND t.start_ms >= ?2 LIMIT 2000`,
    now - 3 * DAY_MS,
  );
  let n = 0;
  for (const u of people) {
    const tz = validZone(u.tz) ?? "UTC";
    const day = addDays(localNow(tz, now).day, -1);
    const report = await buildReport(tdb, u.user_id, day, tz);
    if (!report.totals.turns) continue;
    await tdb.run(
      "INSERT INTO trace_reports (tenant_id, user_id, day, report) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (tenant_id, user_id, day) DO UPDATE SET report = excluded.report, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      u.user_id, day, JSON.stringify(report),
    );
    n++;
  }
  return n;
}

/** Hourly: each person's yesterday for every workspace, then the morning emails. Late traces are picked up by the next run. */
export async function generateDailyReports(env: Env, now = new Date()): Promise<number> {
  const tenants = await env.DB.prepare("SELECT DISTINCT tenant_id FROM trace_apps").all<{ tenant_id: string }>();
  let n = 0;
  const { deliverReports } = await import("./report-mail");
  for (const t of tenants.results ?? []) {
    const tdb = new TenantDB(env.DB, t.tenant_id);
    try {
      n += await generatePeopleReports(tdb, now.getTime());
      await deliverReports(env, tdb, now.getTime());
    } catch (err) {
      console.error("trace_reports_failed", t.tenant_id, String(err));
    }
  }
  return n;
}

/** Stored reports for a person, newest first, as { day, observations, totals } headlines. */
export async function listReports(tdb: TenantDB, userId: string, limit = 30) {
  const rows = await tdb.all<{ day: string; report: string; created_at: string }>("SELECT day, report, created_at FROM trace_reports WHERE tenant_id = ?1 AND user_id = ?2 ORDER BY day DESC LIMIT ?3", userId, limit);
  return rows.map((r) => ({ ...parseJson<DailyReport | null>(r.report, null), day: r.day, created_at: r.created_at })).filter((r) => r.totals);
}

/** One day's report: the stored one, or for a day not yet written (today, or before reports existed) built on the spot. */
export async function getReport(tdb: TenantDB, userId: string, day: string): Promise<(DailyReport & { stored: boolean }) | null> {
  if (!isDay(day)) return null;
  const row = await tdb.first<{ report: string }>("SELECT report FROM trace_reports WHERE tenant_id = ?1 AND user_id = ?2 AND day = ?3", userId, day);
  const stored = row ? parseJson<DailyReport | null>(row.report, null) : null;
  if (stored) return { ...stored, stored: true };
  const person = await tdb.first<{ tz: string | null }>("SELECT tz FROM trace_people WHERE tenant_id = ?1 AND user_id = ?2", userId);
  const live = await buildReport(tdb, userId, day, validZone(person?.tz) ?? "UTC");
  return live.totals.turns ? { ...live, stored: false } : null;
}

// ------------------------------------------------------------------ the team

export interface TeamItem {
  name: string;
  kind: "tool" | "skill" | "plugin" | "mcp" | "subagent" | "command";
  people: number;
  calls: number;
  failures: number;
  /** Who uses it, heaviest first (up to five). */
  who: string[];
}

export interface TeamSummary {
  people: number;
  turns: number;
  total_tokens: number;
  tool_calls: number;
  tool_failures: number;
  /** How many people used each kind of capability at least once. */
  adoption: { skills: number; subagents: number; plugins: number; mcp: number; commands: number };
  items: TeamItem[];
  observations: Observation[];
}

/** What the whole team uses, and how unevenly: the starting point for sharing what works. */
export async function teamSummary(tdb: TenantDB, fromMs: number, toMs: number, appId?: string): Promise<TeamSummary> {
  const app = appId ? " AND s.app_id = ?4" : " AND s.app_id IN (SELECT id FROM trace_apps WHERE tenant_id = ?1 AND kind = 'coding_tool')";
  const binds = appId ? [fromMs, toMs, appId] : [fromMs, toMs];
  const [totals, toolRows, rootRows] = await Promise.all([
    tdb.first<{ people: number; turns: number; total_tokens: number }>(
      `SELECT COUNT(DISTINCT s.user_id) AS people, COUNT(*) AS turns, COALESCE(SUM(s.total_tokens), 0) AS total_tokens
       FROM llm_traces s WHERE s.tenant_id = ?1 AND s.user_id IS NOT NULL AND s.start_ms >= ?2 AND s.start_ms <= ?3${app}`,
      ...binds,
    ),
    tdb.all<{ user_id: string; name: string; skill: string | null; plugin: string | null; subagent: string | null; calls: number; failures: number }>(
      `SELECT s.user_id AS user_id, s.name AS name, ${attr("skill.name")} AS skill, ${attr("plugin.name")} AS plugin, ${attr("subagent.type")} AS subagent,
              COUNT(*) AS calls, COALESCE(SUM(s.status_code = 'ERROR'), 0) AS failures
       FROM llm_spans s WHERE s.tenant_id = ?1 AND s.user_id IS NOT NULL AND s.start_ms >= ?2 AND s.start_ms <= ?3 AND s.kind = 'TOOL'${app}
       GROUP BY s.user_id, s.name, skill, plugin, subagent LIMIT 20000`,
      ...binds,
    ),
    tdb.all<{ user_id: string; command: string; calls: number }>(
      `SELECT s.user_id AS user_id, ${attr("slash.command")} AS command, COUNT(*) AS calls
       FROM llm_spans s WHERE s.tenant_id = ?1 AND s.user_id IS NOT NULL AND s.start_ms >= ?2 AND s.start_ms <= ?3 AND s.parent_span_id IS NULL
         AND ${attr("slash.command")} IS NOT NULL${app}
       GROUP BY s.user_id, command LIMIT 5000`,
      ...binds,
    ),
  ]);

  const items = new Map<string, { name: string; kind: TeamItem["kind"]; calls: number; failures: number; by: Map<string, number> }>();
  const add = (kind: TeamItem["kind"], name: string, user: string, calls: number, failures: number) => {
    const key = `${kind}:${name}`;
    const cur = items.get(key) ?? { name, kind, calls: 0, failures: 0, by: new Map<string, number>() };
    cur.calls += calls;
    cur.failures += failures;
    cur.by.set(user, (cur.by.get(user) ?? 0) + calls);
    items.set(key, cur);
  };
  let toolCalls = 0;
  let toolFailures = 0;
  for (const r of toolRows) {
    toolCalls += r.calls;
    toolFailures += r.failures;
    const k = toolKind(r.name);
    add("tool", r.name, r.user_id, r.calls, r.failures);
    if (k.server) add("mcp", k.server, r.user_id, r.calls, r.failures);
    const plugin = k.plugin ?? r.plugin;
    if (plugin) add("plugin", plugin, r.user_id, r.calls, r.failures);
    if (r.skill) add("skill", r.skill, r.user_id, r.calls, r.failures);
    if (r.subagent) add("subagent", r.subagent, r.user_id, r.calls, r.failures);
  }
  for (const r of rootRows) add("command", r.command, r.user_id, r.calls, 0);

  const list: TeamItem[] = [...items.values()]
    .map((i) => ({ name: i.name, kind: i.kind, people: i.by.size, calls: i.calls, failures: i.failures, who: [...i.by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u]) => u) }))
    .sort((a, b) => b.people - a.people || b.calls - a.calls || a.name.localeCompare(b.name));
  const usersOf = (kind: TeamItem["kind"]) => new Set([...items.values()].filter((i) => i.kind === kind).flatMap((i) => [...i.by.keys()])).size;
  const people = totals?.people ?? 0;
  const adoption = { skills: usersOf("skill"), subagents: usersOf("subagent"), plugins: usersOf("plugin"), mcp: usersOf("mcp"), commands: usersOf("command") };

  const obs: Observation[] = [];
  if (people >= 2) {
    for (const t of list.filter((i) => i.kind === "tool" && i.calls >= 20 && i.failures / i.calls >= 0.15).slice(0, 2)) {
      obs.push({ level: "watch", title: `${t.name} fails ${pct(t.failures / t.calls)} of the time across the team`, detail: `${int(t.failures)} of ${int(t.calls)} calls failed, for ${plural(t.people, "person", "people")}. A shared cause (a permission, a missing tool on some machines) is worth ruling out.` });
    }
    const solo = list.filter((i) => (i.kind === "skill" || i.kind === "plugin" || i.kind === "mcp") && i.people === 1 && i.calls >= 3);
    if (solo.length) {
      obs.push({ level: "tip", title: `${plural(solo.length, "skill, plugin or server", "skills, plugins or servers")} used by one person only`, detail: `${solo.slice(0, 5).map((i) => `${i.name} (${i.who[0]})`).join(", ")}. If these save time, the rest of the team may not know about them.` });
    }
    if (adoption.skills < people && adoption.skills > 0) obs.push({ level: "tip", title: `${adoption.skills} of ${people} people use skills`, detail: `Most used: ${list.filter((i) => i.kind === "skill").slice(0, 3).map((i) => i.name).join(", ")}.` });
    if (adoption.skills === 0 && (totals?.turns ?? 0) >= 20) obs.push({ level: "tip", title: "Nobody used a skill", detail: "Skills package a repeated job (a review, a release, a house style) so it takes one prompt. None were used in this range." });
    if (adoption.subagents < people && adoption.subagents > 0) obs.push({ level: "tip", title: `${adoption.subagents} of ${people} people delegate to subagents`, detail: "Subagents keep long searches and side tasks out of the main conversation." });
    const shared = list.filter((i) => (i.kind === "skill" || i.kind === "plugin" || i.kind === "mcp") && i.people === people);
    if (shared.length) obs.push({ level: "good", title: `Everyone uses ${shared.slice(0, 4).map((i) => i.name).join(", ")}`, detail: "Shared by the whole team in this range." });
    if (toolCalls >= 50 && toolFailures / toolCalls < 0.02) obs.push({ level: "good", title: `${pct(1 - toolFailures / toolCalls)} of tool calls succeeded`, detail: `${int(toolFailures)} failures in ${int(toolCalls)} calls across the team.` });
  }
  const order = { watch: 0, tip: 1, good: 2 } as const;
  return {
    people,
    turns: totals?.turns ?? 0,
    total_tokens: totals?.total_tokens ?? 0,
    tool_calls: toolCalls,
    tool_failures: toolFailures,
    adoption,
    items: list.slice(0, 200),
    observations: obs.sort((a, b) => order[a.level] - order[b.level]).slice(0, 8),
  };
}
