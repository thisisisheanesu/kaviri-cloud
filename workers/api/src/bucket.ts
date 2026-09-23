// The token bucket, as arithmetic.
//
// Kept separate from the Durable Object that stores it so the refill and the rounding can
// be tested without a runtime. A rate limiter that is wrong by one is a rate limiter that
// either lets a burst through or refuses the request a customer paid attention to, and
// neither is discoverable from a log.

export interface BucketState {
  /** Tokens remaining, fractional between refills so a slow drip is not lost to rounding. */
  tokens: number;
  /** When `tokens` was last brought up to date, in milliseconds. */
  updatedAt: number;
}

export interface BucketConfig {
  /** Tokens added per minute, which is also the sustained request rate. */
  perMinute: number;
  /** The most that can accumulate, so an idle hour does not buy an hour of burst. */
  burst: number;
}

export interface BucketDecision {
  allowed: boolean;
  state: BucketState;
  /** What goes in X-RateLimit-Remaining: whole tokens, never negative. */
  remaining: number;
  /** Seconds until the bucket has a whole token again. At least 1 when refused. */
  retryAfterSeconds: number;
  /** Unix seconds for X-RateLimit-Reset: when the bucket is full again. */
  resetAt: number;
}

export function initialState(config: BucketConfig, now: number): BucketState {
  return { tokens: config.burst, updatedAt: now };
}

/**
 * Take one token if there is one.
 *
 * Refill is computed from elapsed time rather than kept on a timer, because a Durable
 * Object that has not been asked anything for an hour should not have been running an
 * alarm for that hour.
 */
export function take(state: BucketState, config: BucketConfig, now: number, cost = 1): BucketDecision {
  const elapsedMs = Math.max(0, now - state.updatedAt);
  const refilled = Math.min(config.burst, state.tokens + (elapsedMs * config.perMinute) / 60_000);

  const allowed = refilled >= cost;
  const tokens = allowed ? refilled - cost : refilled;
  const next: BucketState = { tokens, updatedAt: now };

  const perMs = config.perMinute / 60_000;
  const deficit = allowed ? 0 : cost - tokens;
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(deficit / perMs / 1000));
  const toFull = perMs > 0 ? (config.burst - tokens) / perMs : 0;

  return {
    allowed,
    state: next,
    remaining: Math.max(0, Math.floor(tokens)),
    retryAfterSeconds,
    resetAt: Math.ceil((now + toFull) / 1000),
  };
}

/** The headers docs/API.md promises on every response, refused or not. */
export function rateLimitHeaders(config: BucketConfig, decision: BucketDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(config.perMinute),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(decision.resetAt),
  };
  if (!decision.allowed) headers["Retry-After"] = String(decision.retryAfterSeconds);
  return headers;
}
