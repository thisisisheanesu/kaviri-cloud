// Turning a render_jobs row into the body docs/API.md promises.
//
// Pure, and the only place the eight database states become the six API states. That
// mapping is a contract: `leased` and `uploading` both report as `running` because from
// outside they mean the same thing, which is not ready yet, and a customer who learned to
// branch on a state we later stop using would be broken by fleet bookkeeping.

import { byteaToHex } from "./canonical";

export type ApiStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "expired";

const STATE_TO_STATUS: Record<string, ApiStatus> = {
  queued: "queued",
  leased: "running",
  running: "running",
  uploading: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
};

export function apiStatus(dbState: string): ApiStatus {
  const status = STATE_TO_STATUS[dbState];
  if (!status) throw new Error(`unmapped render_jobs state ${dbState}`);
  return status;
}

/** How long a polite client should wait before asking again, by status. */
export function retryAfterFor(status: ApiStatus): number | null {
  if (status === "queued") return 5;
  if (status === "running") return 2;
  return null;
}

export interface JobRow {
  id: string;
  state: string;
  progress: number | string | null;
  progress_message: string | null;
  attempt: number;
  max_attempts: number;
  script_sha256?: unknown;
  options?: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  render_seconds: number | string | null;
  error: Record<string, unknown> | null;
  projects?: { slug?: string } | { slug?: string }[] | null;
  artifacts?: ArtifactRow[] | null;
}

export interface ArtifactRow {
  kind: string;
  content_type: string;
  bytes: number | string;
  sha256: unknown;
  duration_seconds: number | string | null;
  width: number | null;
  height: number | null;
  deleted_at: string | null;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function projectSlug(row: JobRow): string {
  const p = row.projects;
  if (Array.isArray(p)) return p[0]?.slug ?? "";
  return p?.slug ?? "";
}

/**
 * The error a customer sees on a failed job.
 *
 * Normalised because the worker writes a flat object with op_index at the top level while
 * the API promises a nested `detail`. Doing that translation here rather than asking the
 * fleet to write the API shape keeps the fleet free to add a field without a deploy of
 * this Worker being required for it to be legal.
 */
export function shapeError(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object") return null;
  const { code, message, retryable, detail, ...rest } = raw as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...(typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {}),
    ...rest,
  };
  const out: Record<string, unknown> = {
    code: typeof code === "string" ? code : "render_failed",
    message: typeof message === "string" ? message : "the take did not finish",
    retryable: typeof retryable === "boolean" ? retryable : true,
  };
  if (Object.keys(merged).length > 0) out["detail"] = merged;
  return out;
}

export function shapeArtifacts(jobId: string, status: ApiStatus, rows: ArtifactRow[] | null | undefined) {
  if (!rows) return [];
  return rows
    // A swept artifact is a row that still exists so retention can prove when it went.
    // It is not something a customer can download, so it is not something to list.
    .filter((a) => a.deleted_at === null)
    .map((a) => {
      const shaped: Record<string, unknown> = {
        kind: a.kind,
        content_type: a.content_type,
        bytes: num(a.bytes),
        sha256: byteaToHex(a.sha256),
        duration_seconds: a.duration_seconds === null ? null : num(a.duration_seconds),
        width: a.width,
        height: a.height,
        url: `/v1/jobs/${jobId}/artifact?kind=${a.kind}`,
      };
      // Footage from a take that failed part way is still the fastest way to see what the
      // page actually looked like, so it is offered rather than hidden, and flagged so
      // nobody publishes it thinking it is the whole thing.
      if (status === "failed") shaped["partial"] = true;
      return shaped;
    });
}

export function shapeJob(row: JobRow): Record<string, unknown> {
  const status = apiStatus(row.state);
  const links = {
    self: `/v1/jobs/${row.id}`,
    artifact: `/v1/jobs/${row.id}/artifact`,
  };

  const body: Record<string, unknown> = {
    id: row.id,
    status,
    project: projectSlug(row),
    progress: num(row.progress),
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    expires_at: row.expires_at,
    render_seconds: num(row.render_seconds),
    error: shapeError(row.error),
    artifacts: shapeArtifacts(row.id, status, row.artifacts),
    links,
  };

  if (row.progress_message !== null && row.progress_message !== undefined) {
    body["message"] = row.progress_message;
  }
  if (row.script_sha256 !== undefined) body["script_sha256"] = byteaToHex(row.script_sha256);
  if (row.options !== undefined) body["options"] = row.options;

  return body;
}

/**
 * The columns every job read asks for, in one place so a list and a poll cannot drift.
 *
 * The script itself is not among them. A CI job polls this endpoint every two seconds and
 * already has the script, so sending it back on every poll is the largest column in the
 * table travelling for nothing.
 */
export const JOB_SELECT =
  "id,state,progress,progress_message,attempt,max_attempts,script_sha256,options,created_at,started_at," +
  "finished_at,expires_at,render_seconds,error,projects(slug)," +
  "artifacts(kind,content_type,bytes,sha256,duration_seconds,width,height,deleted_at)";

/** The same, plus what an idempotency replay has to compare against. */
export const JOB_SELECT_WITH_SCRIPT = `${JOB_SELECT},script,idempotency_key`;
