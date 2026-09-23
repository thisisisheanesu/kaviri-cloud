// The job endpoints: submit, poll, list, fetch the MP4, cancel.

import type { Caller } from "../auth";
import { submissionFingerprint } from "../canonical";
import type { Env, RenderQueueMessage } from "../env";
import { intVar } from "../env";
import { effectiveEntitlements } from "../entitlements";
import { ApiError, jsonResponse, notFound } from "../http";
import { mintSignedUrl } from "../../../dl/src/sign";
import {
  JOB_SELECT,
  JOB_SELECT_WITH_SCRIPT,
  apiStatus,
  retryAfterFor,
  shapeJob,
  type ApiStatus,
  type JobRow,
} from "../shape";
import { encodeCursor, UUID, validateListQuery, validateSubmitBody } from "../validate";

export interface RequestContext {
  env: Env;
  ctx: ExecutionContext;
  caller: Caller;
  requestId: string;
  rateHeaders: Record<string, string>;
  url: URL;
}

interface IdempotencyRecord {
  job_id: string;
  fingerprint: string;
}

/**
 * Read the body, refusing one that is too large before parsing it.
 *
 * Content-Length is checked first because it is free, and the byte count is checked again
 * after reading because a chunked request does not have to declare one. Parsing a
 * megabyte of JSON to then decide it was too big is the denial of service the limit
 * exists to prevent.
 */
async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "request_too_large", `the request body is ${declared} bytes and the limit is ${maxBytes}`, {
      bytes: declared,
      limit: maxBytes,
    });
  }

  const text = await request.text();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    throw new ApiError(413, "request_too_large", `the request body is ${bytes} bytes and the limit is ${maxBytes}`, {
      bytes,
      limit: maxBytes,
    });
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(422, "script_invalid", "the request body is not valid JSON");
  }
}

async function fetchJob(rc: RequestContext, id: string): Promise<JobRow> {
  const rows = await rc.caller.db.select(
    // The select list is sent literally. Its commas and parentheses are PostgREST syntax
    // rather than data, and percent encoding them is a round trip with nothing to gain.
    `render_jobs?id=eq.${encodeURIComponent(id)}&select=${JOB_SELECT}&limit=1`,
  );
  const row = rows[0] as JobRow | undefined;
  // Row Level Security has already made another tenant's job invisible, so an empty
  // result is the same answer for "no such job" and "not yours", which is the answer the
  // contract asks for.
  if (!row) throw notFound("no such job");
  return row;
}

function jobHeaders(rc: RequestContext, status: ApiStatus): Record<string, string> {
  const headers = { ...rc.rateHeaders };
  // A polite client honours this and an impolite one meets the token bucket instead.
  const retryAfter = retryAfterFor(status);
  if (retryAfter !== null) headers["Retry-After"] = String(retryAfter);
  return headers;
}

export async function submitJob(request: Request, rc: RequestContext): Promise<Response> {
  const { env, caller, requestId } = rc;
  const raw = await readJsonBody(request, intVar(env.MAX_BODY_BYTES, 1_048_576));
  const body = validateSubmitBody(raw, intVar(env.MAX_SOURCE_BYTES, 4096));

  // Checked at the edge as well as in submit_job so that an oversized script is refused
  // in one cached read rather than after the database has parsed it. submit_job remains
  // the authority: it checks inside the same transaction as the insert, where the count
  // cannot change underneath it.
  const entitlements = await effectiveEntitlements(env, caller.db, caller.orgId);
  if (entitlements.max_script_ops !== null && body.script.length > entitlements.max_script_ops) {
    throw new ApiError(
      402,
      "limit_exceeded",
      `this script has ${body.script.length} ops and the limit is ${entitlements.max_script_ops}`,
      { limit: "max_script_ops", value: entitlements.max_script_ops, requested: body.script.length },
    );
  }

  const idempotencyKey = body.idempotency_key;
  const cacheKey = idempotencyKey === null ? null : `idem:${caller.orgId}:${idempotencyKey}`;

  // Fingerprinted against the RESOLVED options rather than the submitted ones, because
  // submit_job stores the project defaults merged underneath and a stored job is the only
  // thing a replay can be compared with. Comparing a submitted body against a merged row
  // would report a conflict for every project that has a default set, which is a retry
  // refused for no reason the caller can see.
  const resolvedOptions =
    cacheKey === null ? body.options : { ...(await projectDefaults(rc, body.project)), ...body.options };
  const fingerprint = await submissionFingerprint(body.script, resolvedOptions);

  if (cacheKey !== null) {
    const cached = (await env.CACHE.get(cacheKey, "json")) as IdempotencyRecord | null;
    if (cached !== null) {
      if (cached.fingerprint !== fingerprint) throw idempotencyConflict(idempotencyKey!);
      const existing = await fetchJob(rc, cached.job_id);
      return jsonResponse(200, shapeJob(existing), requestId, jobHeaders(rc, apiStatus(existing.state)));
    }

    // KV is eventually consistent and a cache miss is not proof of a first submission, so
    // the database is asked before anything is created. The unique index on
    // (org_id, idempotency_key) is the real guard; this read is what turns a hit into a
    // 200 or a 409 instead of a surprise.
    const found = await findByIdempotencyKey(rc, idempotencyKey!);
    if (found !== null) {
      const storedFingerprint = await submissionFingerprint(found.script, found.options);
      if (storedFingerprint !== fingerprint) throw idempotencyConflict(idempotencyKey!);
      await rememberIdempotency(env, cacheKey, { job_id: found.row.id, fingerprint });
      return jsonResponse(200, shapeJob(found.row), requestId, jobHeaders(rc, apiStatus(found.row.state)));
    }
  }

  const created = (await caller.db.rpc("submit_job", {
    p_org_id: caller.orgId,
    p_project_slug: body.project,
    p_script: body.script,
    p_options: body.options,
    p_idempotency_key: idempotencyKey,
    p_source: body.source,
  })) as JobRow & { idempotency_key?: string | null; script?: unknown; options?: unknown };

  // submit_job resolves an idempotency key itself and returns the original row, so a
  // concurrent twin of this request lands here rather than colliding on the index. If
  // that original renders something else, this is the conflict, discovered late but
  // discovered.
  if (idempotencyKey !== null && created.idempotency_key === idempotencyKey) {
    const storedFingerprint = await submissionFingerprint(created.script, created.options);
    if (storedFingerprint !== fingerprint) throw idempotencyConflict(idempotencyKey);
  }

  if (cacheKey !== null) {
    await rememberIdempotency(env, cacheKey, { job_id: created.id, fingerprint });
  }

  // The nudge, after the row exists. Workers cannot run Chromium, so nothing is rendered
  // here; the fleet leases the row. A send that fails costs the take its head start and
  // nothing else, which is why it is logged rather than turned into a 500 for a job that
  // was in fact accepted.
  const message: RenderQueueMessage = {
    job_id: created.id,
    org_id: caller.orgId,
    enqueued_at: new Date().toISOString(),
  };
  rc.ctx.waitUntil(
    env.RENDER_QUEUE.send(message).catch((err: unknown) => {
      console.error("queue send failed, the poller will still find this job", created.id, err);
    }),
  );

  const shaped = shapeJob({ ...created, projects: { slug: body.project }, artifacts: [] });
  return jsonResponse(202, shaped, requestId, jobHeaders(rc, apiStatus(created.state)));
}

function idempotencyConflict(key: string): ApiError {
  return new ApiError(
    409,
    "idempotency_conflict",
    "that idempotency key was used for a different script or different options",
    { idempotency_key: key },
  );
}

/**
 * A project's default options, cached.
 *
 * Read only to make a replay comparable with what was stored. The defaults themselves are
 * applied by submit_job, inside the transaction, so this read is never what decides what
 * gets rendered.
 */
async function projectDefaults(rc: RequestContext, slug: string): Promise<Record<string, unknown>> {
  const cacheKey = `proj:${rc.caller.orgId}:${slug}`;
  const cached = await rc.env.CACHE.get(cacheKey, "json");
  if (cached !== null) return cached as Record<string, unknown>;

  const rows = (await rc.caller.db.select(
    `projects?slug=eq.${encodeURIComponent(slug)}&select=default_options&limit=1`,
  )) as { default_options?: Record<string, unknown> }[];
  // A project that does not exist yet has no defaults, and will be created by submit_job.
  const defaults = rows[0]?.default_options ?? {};

  await rc.env.CACHE.put(cacheKey, JSON.stringify(defaults), {
    expirationTtl: intVar(rc.env.ENTITLEMENTS_CACHE_TTL_SECONDS, 60),
  });
  return defaults;
}

async function rememberIdempotency(env: Env, cacheKey: string, record: IdempotencyRecord): Promise<void> {
  await env.CACHE.put(cacheKey, JSON.stringify(record), {
    expirationTtl: intVar(env.IDEMPOTENCY_CACHE_TTL_SECONDS, 86_400),
  });
}

async function findByIdempotencyKey(
  rc: RequestContext,
  key: string,
): Promise<{ row: JobRow; script: unknown; options: unknown } | null> {
  const rows = await rc.caller.db.select(
    `render_jobs?idempotency_key=eq.${encodeURIComponent(key)}&select=${JOB_SELECT_WITH_SCRIPT}&limit=1`,
  );
  const row = rows[0] as (JobRow & { script?: unknown; options?: unknown }) | undefined;
  if (!row) return null;
  return { row, script: row.script, options: row.options };
}

export async function getJob(rc: RequestContext, id: string): Promise<Response> {
  if (!UUID.test(id)) throw notFound("no such job");
  const row = await fetchJob(rc, id);
  const status = apiStatus(row.state);
  return jsonResponse(200, shapeJob(row), rc.requestId, jobHeaders(rc, status));
}

export async function listJobs(rc: RequestContext): Promise<Response> {
  const query = validateListQuery(rc.url.searchParams);

  // An embedded filter only narrows the embedding unless the join is declared inner, so
  // without this a filter by project would return every job with an empty projects field
  // rather than the jobs of that project.
  const select = query.project === null ? JOB_SELECT : JOB_SELECT.replace("projects(slug)", "projects!inner(slug)");

  const parts = [
    `select=${select}`,
    "order=created_at.desc,id.desc",
    // One more than asked for, so the presence of a next page is a fact rather than a
    // guess from a full page.
    `limit=${query.limit + 1}`,
  ];

  if (query.project !== null) {
    parts.push(`projects.slug=eq.${encodeURIComponent(query.project)}`);
  }
  if (query.statuses.length > 0) {
    // Two API states map from more than one database state, so the filter is expanded
    // here rather than passed through. Asking for running and getting only the rows that
    // literally say running would silently drop every job that is leased or uploading.
    const states = new Set<string>();
    for (const s of query.statuses) {
      if (s === "running") ["leased", "running", "uploading"].forEach((x) => states.add(x));
      else states.add(s);
    }
    parts.push(`state=in.(${[...states].join(",")})`);
  }
  if (query.cursor !== null) {
    const { created_at, id } = query.cursor;
    parts.push(
      `or=(created_at.lt.${encodeURIComponent(created_at)},and(created_at.eq.${encodeURIComponent(
        created_at,
      )},id.lt.${encodeURIComponent(id)}))`,
    );
  }

  const rows = (await rc.caller.db.select(`render_jobs?${parts.join("&")}`)) as JobRow[];
  const page = rows.slice(0, query.limit);
  const body: Record<string, unknown> = { jobs: page.map(shapeJob) };

  if (rows.length > query.limit) {
    const last = page[page.length - 1];
    if (last) body["next_cursor"] = encodeCursor(last.created_at, last.id);
  }

  return jsonResponse(200, body, rc.requestId, rc.rateHeaders);
}

export async function getArtifact(rc: RequestContext, id: string): Promise<Response> {
  if (!UUID.test(id)) throw notFound("no such job");
  const kind = rc.url.searchParams.get("kind") ?? "video";
  if (!["video", "poster", "telemetry", "log"].includes(kind)) {
    throw notFound(`no artifact of kind ${kind}`);
  }

  const row = await fetchJob(rc, id);
  const status = apiStatus(row.state);

  if (status === "queued" || status === "running") {
    throw new ApiError(409, "job_not_ready", "this job has not finished, so there is nothing to download yet", {
      status,
    });
  }

  const artifacts = (await rc.caller.db.select(
    `artifacts?job_id=eq.${encodeURIComponent(id)}&kind=eq.${encodeURIComponent(kind)}` +
      "&select=storage_key,content_type,bytes,expires_at,deleted_at&limit=1",
  )) as { storage_key: string; content_type: string; bytes: number | string; expires_at: string | null; deleted_at: string | null }[];

  const artifact = artifacts[0];
  if (!artifact) throw notFound(`this job has no ${kind} artifact`);
  if (artifact.deleted_at !== null || status === "expired") {
    // Worth telling apart from a 404: "never existed" and "you waited too long" are
    // different problems, and only one of them is fixed by filming again sooner.
    throw new ApiError(410, "gone", "retention swept this artifact", {
      expired_at: artifact.expires_at ?? row.expires_at,
    });
  }

  // The link points at the dl Worker, not at R2. Handing out an S3 presigned URL would
  // mean this Worker held R2 credentials on the busiest authenticated path in the system,
  // and it would bypass dl entirely: no range handling, no shared edge cache, and no way
  // to take a published link down except by deleting the object. The signature travels in
  // the path rather than the query so that one cached copy serves every link to an object.
  const ttl = intVar(rc.env.SIGNED_URL_TTL_SECONDS, 300);

  // A link must not outlive the artifact it points at, or a customer follows a live
  // signature to a 404 that reads like our fault.
  const retentionLeft = artifact.expires_at
    ? Math.floor((Date.parse(artifact.expires_at) - Date.now()) / 1000)
    : undefined;

  const signed = await mintSignedUrl(rc.env.DL_ORIGIN, {
    key: artifact.storage_key,
    ttlSeconds: ttl,
    secret: rc.env.DL_SIGNING_KEY,
    ...(retentionLeft !== undefined ? { maxTtlSeconds: Math.max(1, retentionLeft) } : {}),
  });

  const bytes = Number(artifact.bytes);

  if (rc.url.searchParams.get("redirect") === "false") {
    // For a caller that cannot follow a redirect without losing its Authorization header,
    // which is most HTTP clients and all of the careful ones.
    // expiresAt is unix seconds; every timestamp this API emits is RFC 3339.
    return jsonResponse(
      200,
      { url: signed.url, expires_at: new Date(signed.expiresAt * 1000).toISOString(), bytes },
      rc.requestId,
      rc.rateHeaders,
    );
  }

  const headers = new Headers({
    Location: signed.url,
    "Cache-Control": "private, max-age=0",
    "X-Kaviri-Request-Id": rc.requestId,
    ...rc.rateHeaders,
  });
  return new Response(null, { status: 302, headers });
}

export async function cancelJob(rc: RequestContext, id: string): Promise<Response> {
  if (!UUID.test(id)) throw notFound("no such job");

  const row = await fetchJob(rc, id);
  const before = apiStatus(row.state);
  if (before === "done" || before === "failed" || before === "cancelled" || before === "expired") {
    throw new ApiError(409, "job_not_cancellable", `this job is already ${before}`, { status: before });
  }

  const result = (await rc.caller.db.rpc("request_cancel", { p_job_id: id })) as string;
  const after = apiStatus(typeof result === "string" ? result : row.state);

  const body = { id, status: after, cancel_requested: true };
  // 200 means it stopped, 202 means it will within one heartbeat. The distinction is
  // real: a job on a box is only flagged, because killing a render mid encode strands a
  // multipart upload in the bucket that no row points at.
  return jsonResponse(after === "cancelled" ? 200 : 202, body, rc.requestId, rc.rateHeaders);
}
