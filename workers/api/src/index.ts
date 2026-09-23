// api.kaviri.dev
//
// You POST a script, you get a job id, you poll it, you download an MP4. Nothing is
// rendered here: a Worker cannot run Chromium, so this Worker writes a row, nudges the
// queue and gets out of the way.
//
// There is one rule this file exists to keep. Every response, including the ones nobody
// planned for, is JSON. A GitHub Action that receives an HTML body reports "expected
// JSON, got <!DOCTYPE html>" and the person reading the log has no way to find out what
// actually happened. See README.md for the half of that problem this Worker cannot solve
// on its own, which is a WAF challenge answering before the Worker ever runs.

import { authenticate, type Caller } from "./auth";
import type { BucketConfig } from "./bucket";
import type { Env } from "./env";
import { intVar } from "./env";
import { ApiError, errorResponse, ulid } from "./http";
import { consume, type BucketName } from "./ratelimit";
import { cancelJob, getArtifact, getJob, listJobs, submitJob, type RequestContext } from "./routes/jobs";
import { getHealth, getUsage } from "./routes/meta";

export { TokenBucket } from "./do/token-bucket";

export interface Route {
  method: string;
  /** Path segments after /v1, with :id standing for one segment. */
  pattern: string[];
  bucket: BucketName;
  handle: (rc: RequestContext, request: Request, params: Record<string, string>) => Promise<Response>;
}

/**
 * Exported so that test/always-json.test.ts can drive every endpoint rather than the
 * handful somebody remembered to list. A route added here is a route that test covers on
 * the same commit, which is the difference between a guarantee and a checklist.
 */
export const ROUTES: Route[] = [
  { method: "POST", pattern: ["jobs"], bucket: "submit", handle: (rc, request) => submitJob(request, rc) },
  { method: "GET", pattern: ["jobs"], bucket: "poll", handle: (rc) => listJobs(rc) },
  { method: "GET", pattern: ["jobs", ":id"], bucket: "poll", handle: (rc, _r, p) => getJob(rc, p["id"]!) },
  {
    method: "GET",
    pattern: ["jobs", ":id", "artifact"],
    bucket: "poll",
    handle: (rc, _r, p) => getArtifact(rc, p["id"]!),
  },
  {
    method: "POST",
    pattern: ["jobs", ":id", "cancel"],
    bucket: "submit",
    handle: (rc, _r, p) => cancelJob(rc, p["id"]!),
  },
  {
    method: "GET",
    pattern: ["usage"],
    bucket: "poll",
    handle: (rc) => getUsage(rc.env, rc.caller, rc.requestId, rc.rateHeaders),
  },
];

function match(segments: string[], pattern: string[]): Record<string, string> | null {
  if (segments.length !== pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = segments[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = s;
    else if (p !== s) return null;
  }
  return params;
}

function bucketConfig(env: Env, bucket: BucketName): BucketConfig {
  const perMinute =
    bucket === "submit" ? intVar(env.RATE_SUBMIT_PER_MIN, 60) : intVar(env.RATE_POLL_PER_MIN, 600);
  // Burst equals the per-minute rate: a client may spend its whole minute at once, which
  // is what a matrix build starting twenty jobs together looks like, and then waits.
  return { perMinute, burst: perMinute };
}

/**
 * The single place an error becomes a response. This wrapper, and not the fetch handler,
 * is what owns the guarantee that every reply is JSON, because the tests drive `route`
 * directly: if the try/catch lived one level up in `fetch`, the conversion the tests
 * exist to prove would be the one line they never execute.
 */
export async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  try {
    return await dispatch(request, env, ctx, requestId);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

async function dispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  if (request.method === "OPTIONS") {
    // Answered here rather than left to the runtime, so a playground on another origin
    // gets a preflight that succeeds instead of a default that quietly does not.
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, X-Kaviri-Org",
        "access-control-max-age": "86400",
      },
    });
  }

  if (segments[0] !== "v1") {
    throw new ApiError(404, "not_found", "there is no unversioned path; every endpoint lives under /v1");
  }
  const rest = segments.slice(1);

  // Health is before authentication on purpose: it is what the Action calls to tell the
  // difference between a service that is down and a credential that is wrong.
  if (rest.length === 1 && rest[0] === "health") {
    if (request.method !== "GET") throw methodNotAllowed(request.method, "GET");
    return getHealth(env, requestId);
  }

  let allowedMethod: string | null = null;
  for (const candidate of ROUTES) {
    const params = match(rest, candidate.pattern);
    if (params === null) continue;
    if (candidate.method !== request.method) {
      allowedMethod = candidate.method;
      continue;
    }

    const caller: Caller = await authenticate(request, env);
    const config = bucketConfig(env, candidate.bucket);
    const { headers } = await consume(env, caller.orgId, candidate.bucket, config);

    const rc: RequestContext = { env, ctx, caller, requestId, rateHeaders: headers, url };
    try {
      return await candidate.handle(rc, request, params);
    } catch (err) {
      throw withRateHeaders(err, headers);
    }
  }

  if (allowedMethod !== null) throw methodNotAllowed(request.method, allowedMethod);
  throw new ApiError(404, "not_found", `no endpoint at ${url.pathname}`);
}

/**
 * Put the budget headers on a refusal, not only on a success.
 *
 * Two reasons, and the second is the one that motivated adding this. A client told 422 has
 * spent a token and still needs to know how many are left, which is what bucket.ts means
 * when it says these headers go on every response whether it was refused or not. And when
 * the rate limiter has degraded to its in-isolate fallback, `X-RateLimit-Mode: degraded` is
 * the one visible sign of it; dropping that header from exactly the responses a caller is
 * looking at while something is wrong would make the signal useless.
 *
 * Headers the error chose for itself win, because they were chosen deliberately: a 429
 * carries its own Retry-After and its own remaining count, and the ambient ones are stale
 * by comparison.
 */
function withRateHeaders(err: unknown, rateHeaders: Record<string, string>): unknown {
  if (!(err instanceof ApiError)) return err;
  return new ApiError(err.status, err.code, err.message, err.detail, { ...rateHeaders, ...err.headers });
}

function methodNotAllowed(used: string, allowed: string): ApiError {
  return new ApiError(405, "not_found", `${used} is not allowed here; use ${allowed}`, undefined, { Allow: allowed });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // route never throws, so nothing the runtime sees can be a body that is not JSON.
    return route(request, env, ctx, ulid());
  },
};
