// Usage and health.

import type { Caller } from "../auth";
import type { Env } from "../env";
import { effectiveEntitlements } from "../entitlements";
import { jsonResponse } from "../http";

/** The first of the current month, UTC, which is how the ledger groups a period. */
export function currentPeriodMonth(now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

interface UsageRow {
  jobs_submitted?: number | string;
  jobs_completed?: number | string;
  jobs_failed?: number | string;
  render_seconds?: number | string;
  bytes_stored?: number | string;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Quantities and limits, and no money at all.
 *
 * This service does not know what anything costs, which is not a simplification: the
 * prices live in a different repository with a different licence, and the only thing that
 * crosses the seam in this direction is a count.
 */
export async function getUsage(
  env: Env,
  caller: Caller,
  requestId: string,
  rateHeaders: Record<string, string>,
): Promise<Response> {
  const month = currentPeriodMonth();

  const [rows, limits] = await Promise.all([
    caller.db.select(
      `v_org_usage_month?org_id=eq.${encodeURIComponent(caller.orgId)}&period_month=eq.${month}` +
        "&select=jobs_submitted,jobs_completed,jobs_failed,render_seconds,bytes_stored&limit=1",
    ),
    effectiveEntitlements(env, caller.db, caller.orgId),
  ]);

  // An org that has not submitted anything this month has no counter row, and the honest
  // answer is zero rather than an empty body the caller has to special-case.
  const row = (rows[0] ?? {}) as UsageRow;

  return jsonResponse(
    200,
    {
      period_month: month,
      usage: {
        jobs_submitted: num(row.jobs_submitted),
        jobs_completed: num(row.jobs_completed),
        jobs_failed: num(row.jobs_failed),
        render_seconds: num(row.render_seconds),
        bytes_stored: num(row.bytes_stored),
      },
      limits: {
        plan_code: limits.plan_code,
        max_concurrent_renders: limits.max_concurrent_renders,
        max_jobs_per_month: limits.max_jobs_per_month,
        max_render_seconds_per_month: limits.max_render_seconds_per_month,
        max_stored_bytes: limits.max_stored_bytes,
        max_job_seconds: limits.max_job_seconds,
        max_script_ops: limits.max_script_ops,
        artifact_retention_days: limits.artifact_retention_days,
      },
    },
    requestId,
    rateHeaders,
  );
}

export interface QueueDepth {
  queued: number | null;
  running: number | null;
}

/**
 * Queue depth, as published rather than counted.
 *
 * This Worker cannot count the queue. Doing so means reading every tenant's rows, which
 * needs a credential that dissolves Row Level Security, and holding one of those at the
 * edge is exactly what the schema was built to avoid. The fleet supervisor, which already
 * has to know how deep the queue is to decide whether to scale, publishes the number into
 * KV instead. When it has not, the field is null, which is honest: an invented number
 * here would be read as a real one.
 */
export async function queueDepth(env: Env): Promise<QueueDepth> {
  try {
    const published = (await env.CACHE.get("health:queue", "json")) as QueueDepth | null;
    if (published && typeof published === "object") {
      return { queued: published.queued ?? null, running: published.running ?? null };
    }
  } catch (err) {
    console.error("could not read the published queue depth", err);
  }
  return { queued: null, running: null };
}

/**
 * Unauthenticated, and deliberately cheap.
 *
 * It exists so the GitHub Action can fail fast with a useful message when the service is
 * down, rather than discovering it as a submission that times out after a minute with
 * nothing in the log but a socket error.
 */
export async function getHealth(env: Env, requestId: string): Promise<Response> {
  let databaseUp = false;
  try {
    const probe = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(2000),
    });
    databaseUp = probe.status < 500;
  } catch (err) {
    console.error("health probe of the database failed", err);
  }

  const depth = await queueDepth(env);
  const ok = databaseUp;

  return jsonResponse(
    ok ? 200 : 503,
    { ok, queue: depth, version: env.SERVICE_VERSION },
    requestId,
    ok ? undefined : { "Retry-After": "15" },
  );
}
