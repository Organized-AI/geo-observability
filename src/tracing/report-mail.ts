/**
 * The daily report by email: each person gets their own, the morning after, in their own time zone.
 * Off until an owner turns it on; a person can stop theirs with the link in every email.
 */
import type { Env } from "../env";
import type { TenantDB } from "../lib/db";
import { publicUrl } from "../lib/basepath";
import { sendMail, type Mail } from "../lib/mailer";
import { normalizeEmail } from "../lib/session";
import { signShare, verifyShare } from "../lib/tokens";
import { addDays, parseJson } from "../lib/util";
import { localNow, validZone } from "./localday";
import type { DailyReport } from "./people";

const SEND_FROM_HOUR = 7; // local time the morning after
const MAX_PER_RUN = 200;

export async function reportEmailsOn(tdb: TenantDB): Promise<boolean> {
  const row = await tdb.first<{ email_reports: number }>("SELECT email_reports FROM trace_settings WHERE tenant_id = ?1");
  return row?.email_reports === 1;
}

export async function setReportEmails(tdb: TenantDB, on: boolean, by: string): Promise<void> {
  await tdb.run(
    `INSERT INTO trace_settings (tenant_id, email_reports, updated_by) VALUES (?1, ?2, ?3)
     ON CONFLICT (tenant_id) DO UPDATE SET email_reports = excluded.email_reports, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    on ? 1 : 0,
    by,
  );
}

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** A signed stop link for one person in one workspace, good for a year. */
export async function unsubscribeToken(secret: string, tenantId: string, userId: string): Promise<string> {
  return signShare(secret, b64url(`${tenantId}\n${userId}`), new Date(Date.now() + 365 * 86_400_000));
}

export async function readUnsubscribeToken(secret: string, token: string): Promise<{ tenantId: string; userId: string } | null> {
  const id = await verifyShare(secret, token);
  if (!id) return null;
  try {
    const [tenantId, userId] = unb64url(id).split("\n");
    return tenantId && userId ? { tenantId, userId } : null;
  } catch {
    return null;
  }
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const list = (items: { name: string; calls: number }[], n = 5) => items.slice(0, n).map((x) => `${x.name} (${int(x.calls)})`).join(", ");

export function reportMail(appName: string, to: string, r: DailyReport, portalLink: string, stopLink: string): Mail {
  const t = r.totals;
  const lines = [
    `Your coding tools on ${r.day}${r.tz && r.tz !== "UTC" ? ` (${r.tz})` : ""}`,
    "",
    `${int(t.turns)} turns in ${int(t.sessions)} sessions, ${tokens(t.total_tokens)} tokens.`,
  ];
  if (r.usual) lines.push(`A usual day for you lately: ${int(r.usual.turns_per_day)} turns, ${tokens(r.usual.tokens_per_day)} tokens.`);
  if (r.apps.length) lines.push(`Tools: ${list(r.apps)}`);
  if (r.models.length) lines.push(`Models: ${list(r.models)}`);
  if (r.skills.length) lines.push(`Skills: ${list(r.skills)}`);
  if (r.subagents.length) lines.push(`Subagents: ${list(r.subagents)}`);
  if (r.projects.length) lines.push(`Projects: ${list(r.projects)}`);
  if (r.observations.length) {
    lines.push("", "Worth a look");
    const tag = { watch: "Watch", tip: "Try", good: "Good" } as const;
    for (const o of r.observations) lines.push(`- ${tag[o.level]}: ${o.title}. ${o.detail}`);
  }
  lines.push("", `Full report: ${portalLink}`, "", `Only you and your workspace owners can see this report. Stop these emails: ${stopLink}`);
  return { to, subject: `${appName}: your day in coding tools, ${r.day}`, text: lines.join("\n") };
}

/** Sends the morning emails due in one workspace. A failed send is retried next hour, for up to three days. */
export async function deliverReports(env: Env, tdb: TenantDB, now: number): Promise<number> {
  if (!(await reportEmailsOn(tdb))) return 0;
  const pub = publicUrl(env);
  if (!pub || !env.SHARE_LINK_SECRET) return 0; // no address to link to, or nothing to sign stop links with
  const base = `${pub.origin}${pub.base}`;
  const oldest = addDays(new Date(now).toISOString().slice(0, 10), -3);
  const rows = await tdb.all<{ user_id: string; day: string; report: string; tz: string | null }>(
    `SELECT r.user_id, r.day, r.report, p.tz FROM trace_reports r
     LEFT JOIN trace_people p ON p.tenant_id = r.tenant_id AND p.user_id = r.user_id
     WHERE r.tenant_id = ?1 AND r.emailed_at IS NULL AND r.day >= ?2 AND COALESCE(p.email_reports, 1) = 1
     ORDER BY r.day LIMIT ${MAX_PER_RUN}`,
    oldest,
  );
  let sent = 0;
  for (const row of rows) {
    const to = normalizeEmail(row.user_id);
    if (!to) continue; // a name that is not an address has nowhere to go
    const tz = validZone(row.tz) ?? "UTC";
    const here = localNow(tz, now);
    if (here.day <= row.day || (here.day === addDays(row.day, 1) && here.hour < SEND_FROM_HOUR)) continue; // not morning yet
    const report = parseJson<DailyReport | null>(row.report, null);
    if (!report?.totals?.turns) continue;
    const stop = `${base}/trace/stop-reports?t=${encodeURIComponent(await unsubscribeToken(env.SHARE_LINK_SECRET, tdb.tenantId, row.user_id))}`;
    const link = `${base}/app/#/traces/person/${encodeURIComponent(row.user_id)}`;
    try {
      await sendMail(env, reportMail(env.APP_NAME ?? "GEO Observability", to, report, link, stop));
      await tdb.run("UPDATE trace_reports SET emailed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?1 AND user_id = ?2 AND day = ?3", row.user_id, row.day);
      sent++;
    } catch (err) {
      console.error("trace_report_email_failed", tdb.tenantId, String(err));
    }
  }
  return sent;
}

/** Records the person's time zone when their coding tool sends one. */
export async function notePerson(tdb: TenantDB, userId: string, tz: string): Promise<void> {
  await tdb.run(
    `INSERT INTO trace_people (tenant_id, user_id, tz) VALUES (?1, ?2, ?3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET tz = excluded.tz, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE trace_people.tz IS NOT excluded.tz`,
    userId,
    tz,
  );
}

export async function stopReports(tdb: TenantDB, userId: string): Promise<void> {
  await tdb.run(
    `INSERT INTO trace_people (tenant_id, user_id, email_reports) VALUES (?1, ?2, 0)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET email_reports = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    userId,
  );
}
