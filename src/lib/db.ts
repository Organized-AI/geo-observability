import { HttpError } from "./util";

type Bind = string | number | null;

/**
 * The only way request code reads or writes client data.
 *
 * Every statement must filter or set `tenant_id` with the placeholder `?1`, and the class binds the
 * tenant id to `?1` itself, so a query can never run against a tenant the caller didn't resolve.
 * Further parameters are `?2`, `?3`, ... in the order passed.
 */
export class TenantDB {
  constructor(
    readonly db: D1Database,
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error("TenantDB needs a tenant id");
  }

  private stmt(sql: string, binds: Bind[]): D1PreparedStatement {
    if (!/\btenant_id\b/i.test(sql) || !/\?1(?!\d)/.test(sql)) {
      throw new Error(`Tenant-scoped query is missing "tenant_id = ?1": ${sql.slice(0, 120)}`);
    }
    return this.db.prepare(sql).bind(this.tenantId, ...binds.map((b) => (b === undefined ? null : b)));
  }

  prepare(sql: string, ...binds: Bind[]): D1PreparedStatement {
    return this.stmt(sql, binds);
  }

  async all<T = Record<string, unknown>>(sql: string, ...binds: Bind[]): Promise<T[]> {
    const r = await this.stmt(sql, binds).all<T>();
    return r.results ?? [];
  }

  async first<T = Record<string, unknown>>(sql: string, ...binds: Bind[]): Promise<T | null> {
    return (await this.stmt(sql, binds).first<T>()) ?? null;
  }

  async run(sql: string, ...binds: Bind[]): Promise<D1Result> {
    return this.stmt(sql, binds).run();
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    if (!stmts.length) return [];
    return this.db.batch(stmts);
  }

  /** Throws 404 unless the project belongs to this tenant. */
  async project(projectId: string): Promise<ProjectRow> {
    const p = await this.first<ProjectRow>("SELECT * FROM projects WHERE tenant_id = ?1 AND id = ?2", projectId);
    if (!p) throw new HttpError(404, "not_found", "Project not found");
    return p;
  }
}

export interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  domain: string;
  schedule: string;
  onboarding_step: string;
  created_at: string;
}

export interface BrandRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  aliases: string;
  regex: string | null;
  domains: string;
  socials: string;
  is_own: number;
  status: string;
  color: string | null;
}

export interface PromptRow {
  id: string;
  tenant_id: string;
  project_id: string;
  topic_id: string | null;
  persona_id: string | null;
  text: string;
  country: string;
  language: string;
  intent: string;
  branded: number;
  volume: number | null;
  tags: string;
  status: string;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  email_domain: string | null;
  plan: string;
  prompt_limit: number;
  project_limit: number;
  model_limit: number;
  country_limit: number;
  monthly_spend_cap_micros: number;
  status: string;
}
