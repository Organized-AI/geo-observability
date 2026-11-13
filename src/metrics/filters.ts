import { addDays, daysBetween, HttpError, isDay, today } from "../lib/util";

export interface Filters {
  from: string;
  to: string;
  engines: string[];
  countries: string[];
  topics: string[];
  tags: string[];
  prompts: string[];
}

const csv = (v: string | null | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

export function parseFilters(q: URLSearchParams, defaultDays = 14): Filters {
  const to = q.get("to") && isDay(q.get("to")) ? (q.get("to") as string) : today();
  const from = q.get("from") && isDay(q.get("from")) ? (q.get("from") as string) : addDays(to, -(defaultDays - 1));
  if (from > to) throw new HttpError(400, "bad_range", "from must be on or before to");
  if (daysBetween(from, to) > 400) throw new HttpError(400, "bad_range", "Pick a range of 400 days or less");
  return {
    from,
    to,
    engines: csv(q.get("engine")),
    countries: csv(q.get("country")).map((c) => c.toUpperCase()),
    topics: csv(q.get("topic")),
    tags: csv(q.get("tag")),
    prompts: csv(q.get("prompt")),
  };
}

export function previousPeriod(f: Filters): Filters {
  const n = daysBetween(f.from, f.to);
  return { ...f, from: addDays(f.from, -n), to: addDays(f.from, -1) };
}

/**
 * Collects bind values for a TenantDB statement. ?1 is always the tenant id, so values start at ?2.
 */
export class Binds {
  values: (string | number | null)[] = [];
  add(v: string | number | null): string {
    this.values.push(v);
    return `?${this.values.length + 1}`;
  }
  list(vs: (string | number)[]): string {
    return vs.map((v) => this.add(v)).join(", ");
  }
}

/**
 * The common table expression every report starts from: finished runs in the project and range,
 * narrowed by the global filters. Columns: id, run_date, engine, country, prompt_id, topic_id.
 */
export function runsCte(b: Binds, projectId: string, f: Filters): string {
  const where = [
    "runs.tenant_id = ?1",
    `runs.project_id = ${b.add(projectId)}`,
    "runs.status = 'done'",
    `runs.run_date BETWEEN ${b.add(f.from)} AND ${b.add(f.to)}`,
  ];
  if (f.engines.length) where.push(`runs.engine IN (${b.list(f.engines)})`);
  if (f.countries.length) where.push(`runs.country IN (${b.list(f.countries)})`);
  if (f.topics.length) where.push(`p.topic_id IN (${b.list(f.topics)})`);
  if (f.prompts.length) where.push(`runs.prompt_id IN (${b.list(f.prompts)})`);
  if (f.tags.length) where.push(`EXISTS (SELECT 1 FROM json_each(p.tags) jt WHERE jt.value IN (${b.list(f.tags)}))`);
  return `r AS MATERIALIZED (
    SELECT runs.id, runs.run_date, runs.engine, runs.country, runs.prompt_id, p.topic_id
    FROM runs JOIN prompts p ON p.id = runs.prompt_id AND p.tenant_id = ?1
    WHERE ${where.join(" AND ")}
  )`;
}

/** SQL that matches a domain column against a brand's domains, including subdomains. */
export function domainMatch(b: Binds, column: string, domains: string[]): string {
  if (!domains.length) return "0";
  return `(${domains.map((d) => `${column} = ${b.add(d)} OR ${column} LIKE ${b.add(`%.${d}`)}`).join(" OR ")})`;
}
