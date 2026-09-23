import { describe, expect, it } from "vitest";
import { initialState, rateLimitHeaders, take, type BucketConfig } from "../src/bucket";

const config: BucketConfig = { perMinute: 60, burst: 60 };
const T0 = 1_758_623_000_000;

describe("the token bucket", () => {
  it("starts full and spends one token per request", () => {
    let state = initialState(config, T0);
    const first = take(state, config, T0);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(59);
    state = first.state;
    expect(take(state, config, T0).remaining).toBe(58);
  });

  it("refuses when the bucket is empty and says how long to wait", () => {
    let state = initialState(config, T0);
    for (let i = 0; i < 60; i++) state = take(state, config, T0).state;

    const refused = take(state, config, T0);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    // A minute of budget spent at one instant refills at one per second, so the next
    // token is a second away. Never zero: a Retry-After of zero is an invitation to a
    // retry storm.
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it("refills with elapsed time rather than on a timer", () => {
    let state = initialState(config, T0);
    for (let i = 0; i < 60; i++) state = take(state, config, T0).state;

    const tenSecondsLater = take(state, config, T0 + 10_000);
    expect(tenSecondsLater.allowed).toBe(true);
    expect(tenSecondsLater.remaining).toBe(9);
  });

  it("does not let an idle hour buy an hour of burst", () => {
    const state = initialState(config, T0);
    const muchLater = take(state, config, T0 + 3_600_000);
    expect(muchLater.remaining).toBe(59);
  });

  it("keeps fractional tokens, so a slow drip is not rounded away", () => {
    let state = initialState(config, T0);
    for (let i = 0; i < 60; i++) state = take(state, config, T0).state;

    // Half a token arrives after half a second. Two of those is one request.
    const halfway = take(state, config, T0 + 500);
    expect(halfway.allowed).toBe(false);
    expect(halfway.state.tokens).toBeCloseTo(0.5, 6);
    expect(take(halfway.state, config, T0 + 1000).allowed).toBe(true);
  });

  it("reports the three headers on an allowed request and adds Retry-After on a refusal", () => {
    const allowed = take(initialState(config, T0), config, T0);
    const headers = rateLimitHeaders(config, allowed);
    expect(headers["X-RateLimit-Limit"]).toBe("60");
    expect(headers["X-RateLimit-Remaining"]).toBe("59");
    expect(Number(headers["X-RateLimit-Reset"])).toBeGreaterThan(T0 / 1000);
    expect(headers["Retry-After"]).toBeUndefined();

    const refused = { ...allowed, allowed: false, retryAfterSeconds: 4 };
    expect(rateLimitHeaders(config, refused)["Retry-After"]).toBe("4");
  });
});
