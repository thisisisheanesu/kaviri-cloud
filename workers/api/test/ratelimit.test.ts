// What the limiter does when the Durable Object will not answer.
//
// The behaviour under test is the middle path documented at the top of src/ratelimit.ts:
// not fail open, which is a bypass anybody can trigger by making the object unreachable,
// and not fail closed, which turns one Durable Object incident into a total API outage.
// Every assertion below is about the boundary between those two.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BucketConfig } from "../src/bucket";
import type { Env } from "../src/env";
import { ApiError } from "../src/http";
import { consume, degradedConfig, FALLBACK_LIMITS, resetFallbackBuckets } from "../src/ratelimit";

const ORG = "22222222-2222-4222-a222-222222222222";
const CONFIG: BucketConfig = { perMinute: 60, burst: 60 };

interface StubBehaviour {
  /** Throw on every call, which is what an unreachable object looks like from here. */
  throwAlways?: boolean;
  /** Throw this many times and then answer, which is what a relocating object looks like. */
  throwTimes?: number;
  /** Answer with this status instead of 200. */
  status?: number;
  /** Answer 200 with this exact body text. */
  bodyText?: string;
  /** Answer 200 with a normal allow. */
  allowed?: boolean;
}

let calls = 0;

function envWith(behaviour: StubBehaviour, degradedPercent = "20"): Env {
  calls = 0;
  return {
    RATE_LIMIT: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          calls++;
          if (behaviour.throwAlways) throw new Error("connection refused");
          if (behaviour.throwTimes !== undefined && calls <= behaviour.throwTimes) {
            throw new Error("durable object is being relocated");
          }
          if (behaviour.bodyText !== undefined) {
            return new Response(behaviour.bodyText, { status: behaviour.status ?? 200 });
          }
          if (behaviour.status !== undefined && behaviour.status >= 400) {
            return new Response("<!DOCTYPE html><h1>error</h1>", { status: behaviour.status });
          }
          return new Response(
            JSON.stringify({
              allowed: behaviour.allowed ?? true,
              remaining: 59,
              retryAfterSeconds: behaviour.allowed === false ? 4 : 0,
              resetAt: 1758623045,
            }),
          );
        },
      }),
    },
    RATE_DEGRADED_PERCENT: degradedPercent,
  } as unknown as Env;
}

async function consumeOrError(env: Env, org = ORG) {
  try {
    const result = await consume(env, org, "submit", CONFIG);
    return { ok: true as const, result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false as const, error: err };
    throw err;
  }
}

// Every degraded decision logs, on purpose, because an operator needs to see it. The tests
// below take that path thousands of times, so the log is silenced here rather than allowed
// to bury the one line that says which assertion failed.
const silenced = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => silenced.mockRestore());

beforeEach(() => {
  resetFallbackBuckets();
});

describe("the healthy path is unchanged", () => {
  it("uses the Durable Object's decision and says nothing about degradation", async () => {
    const env = envWith({ allowed: true });
    const result = await consume(env, ORG, "submit", CONFIG);
    expect(result.degraded).toBe(false);
    expect(result.headers["X-RateLimit-Mode"]).toBeUndefined();
    expect(result.headers["X-RateLimit-Limit"]).toBe("60");
    expect(calls).toBe(1);
  });

  it("still refuses with 429 and Retry-After when the object says no", async () => {
    const env = envWith({ allowed: false });
    const outcome = await consumeOrError(env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.status).toBe(429);
    expect(outcome.error.code).toBe("rate_limited");
    expect(outcome.error.headers?.["Retry-After"]).toBe("4");
  });

  it("retries once, so a single transient stub error is not a degradation", async () => {
    const env = envWith({ throwTimes: 1 });
    const result = await consume(env, ORG, "submit", CONFIG);
    expect(result.degraded).toBe(false);
    expect(calls).toBe(2);
  });

  it("gives up after the second attempt rather than retrying forever", async () => {
    const env = envWith({ throwAlways: true });
    await consume(env, ORG, "submit", CONFIG);
    expect(calls).toBe(2);
  });
});

describe("an unreachable Durable Object degrades rather than disappearing", () => {
  it("does not fail closed: the first request through still succeeds", async () => {
    const env = envWith({ throwAlways: true });
    const result = await consume(env, ORG, "submit", CONFIG);
    expect(result.degraded).toBe(true);
    expect(result.headers["X-RateLimit-Mode"]).toBe("degraded");
  });

  it("does not fail open: the budget is the configured share and then it refuses", async () => {
    // Twenty per cent of sixty is twelve, and no clock advances inside this loop, so the
    // bucket cannot refill. Anything other than exactly twelve allows means the fallback
    // budget is not being spent, which is the old bug wearing a new header.
    const env = envWith({ throwAlways: true });
    const expected = degradedConfig(env, CONFIG).perMinute;
    expect(expected).toBe(12);

    let allowed = 0;
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      const outcome = await consumeOrError(env);
      if (outcome.ok) allowed++;
      else {
        refused++;
        expect(outcome.error.status).toBe(429);
        expect(outcome.error.headers?.["X-RateLimit-Mode"]).toBe("degraded");
      }
    }
    expect(allowed).toBe(expected);
    expect(refused).toBe(200 - expected);
  });

  it("keeps one org's degraded budget out of another org's", async () => {
    const env = envWith({ throwAlways: true });
    for (let i = 0; i < 12; i++) await consume(env, ORG, "submit", CONFIG);
    const first = await consumeOrError(env, ORG);
    expect(first.ok).toBe(false);

    const other = await consumeOrError(env, "33333333-3333-4333-a333-333333333333");
    expect(other.ok).toBe(true);
  });

  it("treats a non-2xx from the object as unreachable rather than as an allow", async () => {
    // The specific shape that matters: a 500 whose body is HTML. Parsing that body and
    // trusting whatever came out is how an error becomes permission.
    const env = envWith({ status: 500 });
    const result = await consume(env, ORG, "submit", CONFIG);
    expect(result.degraded).toBe(true);
  });

  it("treats a 200 with no decision in it as unreachable", async () => {
    const env = envWith({ bodyText: JSON.stringify({ remaining: 999 }) });
    const result = await consume(env, ORG, "submit", CONFIG);
    expect(result.degraded).toBe(true);
  });

  it("treats a 200 that is not JSON at all as unreachable", async () => {
    const env = envWith({ bodyText: "<!DOCTYPE html>" });
    const result = await consume(env, ORG, "submit", CONFIG);
    expect(result.degraded).toBe(true);
  });

  it("recovers the moment the object answers again", async () => {
    const throwing = envWith({ throwAlways: true });
    const degraded = await consume(throwing, ORG, "submit", CONFIG);
    expect(degraded.degraded).toBe(true);

    const healthy = envWith({ allowed: true });
    const recovered = await consume(healthy, ORG, "submit", CONFIG);
    expect(recovered.degraded).toBe(false);
    expect(recovered.headers["X-RateLimit-Mode"]).toBeUndefined();
  });

  it("never grants less than one token, however small the configured share", async () => {
    // A percentage of a small budget rounds to zero long before anybody expects it, and a
    // budget of zero is the fail closed behaviour this mechanism exists to avoid.
    const env = envWith({ throwAlways: true }, "1");
    expect(degradedConfig(env, { perMinute: 10, burst: 10 }).perMinute).toBe(1);
    const result = await consume(env, ORG, "submit", { perMinute: 10, burst: 10 });
    expect(result.degraded).toBe(true);
  });

  it("caps how many orgs one isolate will track while degraded", async () => {
    // The map is keyed by a value the caller influences, so without a ceiling it is a slow
    // memory leak. Past the ceiling the answer is a 429, which is the one place this design
    // deliberately fails closed, and it is reached only by an isolate that is already
    // degraded and already tracking ten thousand live orgs.
    const env = envWith({ throwAlways: true });
    for (let i = 0; i < FALLBACK_LIMITS.maxEntries; i++) {
      await consume(env, `org-${i}`, "submit", CONFIG);
    }
    const overflow = await consumeOrError(env, "one-org-too-many");
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.status).toBe(429);
    expect(overflow.error.headers?.["Retry-After"]).toBe("60");
  });
});
