// What a tenant is allowed to do.
//
// Read through app.effective_entitlements and never from org_entitlements directly, which
// the schema is explicit about: the raw table has no platform ceiling applied, so a
// reader of the table would let an unmetered tenant ask for an hour of Chromium on a
// shared box. This Worker does not know the ceilings and must not learn them, because a
// copy of them here is a copy that drifts.
//
// Nothing about money passes through this file. A limit is reported, it is named, and
// that is the whole of what the open service has to say on the subject.

import type { Env } from "./env";
import { intVar } from "./env";
import type { Postgrest } from "./pg";

export interface Entitlements {
  plan_code: string;
  max_concurrent_renders: number | null;
  max_jobs_per_month: number | null;
  max_render_seconds_per_month: number | null;
  max_stored_bytes: number | null;
  max_job_seconds: number | null;
  max_script_ops: number | null;
  artifact_retention_days: number | null;
  extra_limits: Record<string, unknown>;
}

/**
 * Cached per org, briefly.
 *
 * An entitlement changes when somebody changes a plan, which is rare, and it is read on
 * every submission, which is not. A minute of staleness costs at most a minute of the old
 * limit and saves a round trip on the hot path.
 */
export async function effectiveEntitlements(env: Env, db: Postgrest, orgId: string): Promise<Entitlements> {
  const cacheKey = `ent:${orgId}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached !== null) return cached as Entitlements;

  const rows = await db.select("rpc/effective_entitlements", {
    method: "POST",
    schema: env.APP_RPC_SCHEMA,
    body: { p_org_id: orgId },
  });
  const row = (rows[0] ?? {}) as Partial<Entitlements>;

  const entitlements: Entitlements = {
    plan_code: row.plan_code ?? "unmetered",
    max_concurrent_renders: row.max_concurrent_renders ?? null,
    max_jobs_per_month: row.max_jobs_per_month ?? null,
    max_render_seconds_per_month: row.max_render_seconds_per_month ?? null,
    max_stored_bytes: row.max_stored_bytes ?? null,
    max_job_seconds: row.max_job_seconds ?? null,
    max_script_ops: row.max_script_ops ?? null,
    artifact_retention_days: row.artifact_retention_days ?? null,
    extra_limits: row.extra_limits ?? {},
  };

  await env.CACHE.put(cacheKey, JSON.stringify(entitlements), {
    expirationTtl: intVar(env.ENTITLEMENTS_CACHE_TTL_SECONDS, 60),
  });
  return entitlements;
}
