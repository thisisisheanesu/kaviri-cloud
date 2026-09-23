// Asking the org's bucket whether this request may proceed.

import {
  initialState,
  rateLimitHeaders,
  take,
  type BucketConfig,
  type BucketDecision,
  type BucketState,
} from "./bucket";
import type { Env } from "./env";
import { intVar } from "./env";
import { ApiError } from "./http";

export type BucketName = "submit" | "poll";

export interface RateResult {
  headers: Record<string, string>;
  decision: BucketDecision;
  /** True when the answer came from the in-isolate fallback rather than the Durable Object. */
  degraded: boolean;
}

/**
 * WHAT HAPPENS WHEN THE DURABLE OBJECT CANNOT BE REACHED, AND WHY.
 *
 * This code used to return `allowed: true` with a full budget whenever the stub threw. That
 * is a bypass with a very short recipe: make the Durable Object unreachable and the limiter
 * stops existing. It is worth writing down why the obvious correction, failing closed, is
 * also wrong, because the next person to read this file will reach for it.
 *
 * Every authenticated request in this Worker passes through here, so a limiter that refuses
 * on error converts one Durable Object incident into a total outage of the API, including
 * the poll loops of customers who are doing nothing wrong and the cancel endpoint they
 * would use to stop paying for a runaway render. A rate limiter is not worth an outage.
 *
 * Failing open is not cheap either, and it got more expensive rather than less. The old
 * comment argued that `submit_job` enforces the limits that actually cost money, so an open
 * limiter was harmless. Under `BILLING_MODE=none`, which is the configuration this open
 * repository ships and the one CI proves, every tenant limit resolves to null. There is
 * nothing behind the limiter to catch an unmetered flood of submissions, so the limiter is
 * the fence rather than a politeness layer in front of one.
 *
 * So neither end of the switch is acceptable and the answer is in the middle: when the
 * Durable Object cannot answer, this isolate answers from its own memory, at a deliberately
 * reduced rate. The arithmetic is the same `take` the Durable Object runs, against a bucket
 * held in a module level map, configured at `RATE_DEGRADED_PERCENT` of the real budget.
 *
 * What that buys, stated honestly, because the guarantee is weaker than the one the Durable
 * Object gives and pretending otherwise would be worse than failing open:
 *
 *   - It is not exact. Cloudflare runs this Worker in many isolates, so the worst case
 *     global rate during an outage is the degraded rate multiplied by the number of live
 *     isolates serving that org. That is unpleasant and it is still bounded, which is the
 *     whole difference from the previous behaviour, where the bound was the attacker's
 *     bandwidth.
 *   - It does not survive an isolate being recycled. A fresh isolate starts with a fresh
 *     budget. Over a long outage this leaks some extra requests, and the alternative is
 *     persistence, which is the thing that is broken.
 *   - It is per isolate rather than per colo, so a customer geographically spread across
 *     regions gets more headroom during an outage than one in a single region. Degradation
 *     being uneven is acceptable; degradation being absent is not.
 *
 * Degraded answers carry `X-RateLimit-Mode: degraded`, which is the signal to alert on. The
 * absence of that header on normal traffic means an alert can be a simple count rather than
 * a ratio, and a customer support conversation about a surprising 429 can be settled by
 * looking at one response header.
 */

/** The reduced share of the real budget an isolate hands out on its own, as a percentage. */
const DEGRADED_PERCENT_DEFAULT = 20;

/**
 * How many (org, bucket) pairs one isolate will track while degraded.
 *
 * The map is only alive for as long as an outage lasts, but it is keyed by a value the
 * caller influences, so it needs a ceiling or it is a slow memory leak that a caller with
 * many orgs can drive. See `rememberFallback` for what happens at the ceiling.
 */
const FALLBACK_MAX_ENTRIES = 10_000;

/**
 * An entry idle this long has refilled to full anyway, so evicting it grants nothing that
 * keeping it would have refused. Two minutes is comfortably longer than the time any bucket
 * here takes to refill at its degraded rate.
 */
const FALLBACK_IDLE_MS = 120_000;

const fallbackBuckets = new Map<string, BucketState>();

/** Tests reach for this. Nothing in the request path should, and nothing does. */
export function resetFallbackBuckets(): void {
  fallbackBuckets.clear();
}

/** Tests reach for this too, to assert the ceiling is the size it claims to be. */
export const FALLBACK_LIMITS = { maxEntries: FALLBACK_MAX_ENTRIES, idleMs: FALLBACK_IDLE_MS };

/** The budget one isolate is willing to grant by itself, which is a fraction of the real one. */
export function degradedConfig(env: Env, config: BucketConfig): BucketConfig {
  const percent = Math.min(100, intVar(env.RATE_DEGRADED_PERCENT, DEGRADED_PERCENT_DEFAULT));
  // At least one token, because a limiter that can never allow anything is the fail closed
  // behaviour this whole mechanism exists to avoid, and a percentage of a small budget
  // rounds to zero sooner than anybody expects.
  const perMinute = Math.max(1, Math.floor((config.perMinute * percent) / 100));
  // Burst equals the rate rather than the real burst. A burst allowance exists so a matrix
  // build can spend its minute at once, and letting it do that in every isolate at once is
  // exactly the multiplication this fallback is trying to keep small.
  return { perMinute, burst: perMinute };
}

/**
 * Find or create this isolate's bucket, refusing rather than growing past the ceiling.
 *
 * Returning null means "no room to track you", and the caller turns that into a 429. That
 * is a deliberate sliver of fail closed behaviour, reached only when one isolate is already
 * degraded and already tracking ten thousand live orgs, which is a state no legitimate
 * traffic pattern produces.
 */
function rememberFallback(key: string, config: BucketConfig, now: number): BucketState | null {
  const existing = fallbackBuckets.get(key);
  if (existing) return existing;

  if (fallbackBuckets.size >= FALLBACK_MAX_ENTRIES) {
    for (const [candidate, state] of fallbackBuckets) {
      if (now - state.updatedAt >= FALLBACK_IDLE_MS) fallbackBuckets.delete(candidate);
    }
    if (fallbackBuckets.size >= FALLBACK_MAX_ENTRIES) return null;
  }

  const fresh = initialState(config, now);
  fallbackBuckets.set(key, fresh);
  return fresh;
}

/**
 * One token from one bucket.
 *
 * The object is named for the org and the bucket, so two orgs never queue behind each
 * other and a poll loop never spends a submit token. An unauthenticated request never
 * reaches here: it has no org to be limited against, and the endpoints that allow one
 * (health) are cheap by construction.
 */
export async function consume(
  env: Env,
  orgId: string,
  bucket: BucketName,
  config: BucketConfig,
): Promise<RateResult> {
  const name = `${bucket}:${orgId}`;

  let decision: BucketDecision | null = null;
  let lastError: unknown = null;

  // Two attempts, not one and not five. A Durable Object stub throws on transient
  // conditions that a second call usually survives, such as the object being relocated or
  // its code having just been replaced, and a single retry catches those without turning a
  // real outage into a request that takes twice as long to fail.
  for (let attempt = 0; attempt < 2 && decision === null; attempt++) {
    try {
      decision = await askDurableObject(env, name, config);
    } catch (err) {
      lastError = err;
    }
  }

  if (decision !== null) {
    const headers = rateLimitHeaders(config, decision);
    if (!decision.allowed) throw refusal(bucket, decision, headers);
    return { headers, decision, degraded: false };
  }

  console.error("rate limiter unreachable, degrading to the in-isolate budget", orgId, bucket, lastError);

  const degraded = degradedConfig(env, config);
  const now = Date.now();
  const state = rememberFallback(name, degraded, now);

  if (state === null) {
    // No room to track another org while degraded. Refusing is the honest answer: this
    // isolate cannot say whether the caller is within its budget, and it has already
    // proved it is under pressure.
    const headers = {
      "X-RateLimit-Limit": String(degraded.perMinute),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(Math.ceil(now / 1000) + 60),
      "Retry-After": "60",
      "X-RateLimit-Mode": "degraded",
    };
    throw new ApiError(
      429,
      "rate_limited",
      "the rate limiter is degraded and cannot track another org right now; retry in 60 seconds",
      { bucket, retry_after: 60, mode: "degraded" },
      headers,
    );
  }

  const fallback = take(state, degraded, now);
  fallbackBuckets.set(name, fallback.state);

  const headers = { ...rateLimitHeaders(degraded, fallback), "X-RateLimit-Mode": "degraded" };
  if (!fallback.allowed) throw refusal(bucket, fallback, headers);
  return { headers, decision: fallback, degraded: true };
}

async function askDurableObject(env: Env, name: string, config: BucketConfig): Promise<BucketDecision> {
  const stub = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(name));
  const response = await stub.fetch("https://rate-limit.invalid/take", {
    method: "POST",
    body: JSON.stringify({ perMinute: config.perMinute, burst: config.burst, cost: 1 }),
  });

  // A non-2xx from the object is a failure like any other. Reading a body off it and
  // trusting whatever parsed is how a 500 with an HTML body became an allow.
  if (!response.ok) throw new Error(`rate limit object answered ${response.status}`);

  const body = (await response.json()) as Partial<Omit<BucketDecision, "state">>;
  if (typeof body.allowed !== "boolean") throw new Error("rate limit object answered without a decision");

  return {
    allowed: body.allowed,
    remaining: Number(body.remaining ?? 0),
    retryAfterSeconds: Number(body.retryAfterSeconds ?? 0),
    resetAt: Number(body.resetAt ?? Math.ceil(Date.now() / 1000) + 60),
    state: { tokens: Number(body.remaining ?? 0), updatedAt: Date.now() },
  };
}

/**
 * A clear 429 with Retry-After, not a generic error. A GitHub Action that is told to come
 * back in four seconds comes back in four seconds; one that is told only that something
 * went wrong retries immediately and makes it worse.
 */
function refusal(bucket: BucketName, decision: BucketDecision, headers: Record<string, string>): ApiError {
  return new ApiError(
    429,
    "rate_limited",
    `too many ${bucket} requests for this org; retry in ${decision.retryAfterSeconds} seconds`,
    { bucket, retry_after: decision.retryAfterSeconds },
    headers,
  );
}
