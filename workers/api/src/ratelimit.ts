// Asking the org's bucket whether this request may proceed.

import { rateLimitHeaders, type BucketConfig, type BucketDecision } from "./bucket";
import type { Env } from "./env";
import { ApiError } from "./http";

export type BucketName = "submit" | "poll";

export interface RateResult {
  headers: Record<string, string>;
  decision: BucketDecision;
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
  const id = env.RATE_LIMIT.idFromName(`${bucket}:${orgId}`);
  const stub = env.RATE_LIMIT.get(id);

  let decision: BucketDecision;
  try {
    const response = await stub.fetch("https://rate-limit.invalid/take", {
      method: "POST",
      body: JSON.stringify({ perMinute: config.perMinute, burst: config.burst, cost: 1 }),
    });
    const body = (await response.json()) as Omit<BucketDecision, "state">;
    decision = { ...body, state: { tokens: body.remaining, updatedAt: Date.now() } };
  } catch (err) {
    // A limiter that is unreachable must not take the service down with it. Failing open
    // is the right answer here because the thing behind the limiter, submit_job, enforces
    // the limits that actually cost money, and a poll is cheap.
    console.error("rate limiter unreachable, failing open", orgId, bucket, err);
    return {
      headers: {
        "X-RateLimit-Limit": String(config.perMinute),
        "X-RateLimit-Remaining": String(config.perMinute),
        "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
      },
      decision: {
        allowed: true,
        remaining: config.perMinute,
        retryAfterSeconds: 0,
        resetAt: Math.ceil(Date.now() / 1000) + 60,
        state: { tokens: config.perMinute, updatedAt: Date.now() },
      },
    };
  }

  const headers = rateLimitHeaders(config, decision);
  if (!decision.allowed) {
    // A clear 429 with Retry-After, not a generic error. A GitHub Action that is told to
    // come back in four seconds comes back in four seconds; one that is told only that
    // something went wrong retries immediately and makes it worse.
    throw new ApiError(
      429,
      "rate_limited",
      `too many ${bucket} requests for this org; retry in ${decision.retryAfterSeconds} seconds`,
      { bucket, retry_after: decision.retryAfterSeconds },
      headers,
    );
  }
  return { headers, decision };
}
