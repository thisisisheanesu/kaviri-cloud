// The per-org rate limiter, as a Durable Object.
//
// A Durable Object and not KV. A limit that two colos read and write at the same instant
// has to serialise somewhere, and KV is eventually consistent: a burst arriving in three
// regions would be given three full budgets and the limit would mean nothing. A Durable
// Object is one place, for one org, that every request for that org queues behind.
//
// One object per (org, bucket) pair. Submission and polling are separate objects because
// they are separate budgets: a CI job polling every two seconds must not spend its own
// ability to submit the next take.

import { initialState, take, type BucketConfig, type BucketDecision, type BucketState } from "../bucket";

export class TokenBucket implements DurableObject {
  private state: BucketState | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { perMinute?: number; burst?: number; cost?: number };
    const config: BucketConfig = {
      perMinute: Math.max(1, Math.floor(body.perMinute ?? 60)),
      burst: Math.max(1, Math.floor(body.burst ?? body.perMinute ?? 60)),
    };
    const now = Date.now();

    // Read through the in-memory copy first. The object is single threaded, so the copy
    // cannot be stale with respect to another writer, and the storage read only happens
    // when this object has just woken up.
    if (this.state === null) {
      this.state = (await this.ctx.storage.get<BucketState>("bucket")) ?? initialState(config, now);
    }

    const decision: BucketDecision = take(this.state, config, now, Math.max(1, Math.floor(body.cost ?? 1)));
    this.state = decision.state;

    // Not awaited before answering. Losing the write in a crash costs one caller a few
    // extra tokens, and waiting for the disk on every request costs every caller latency
    // on the busiest path in the system.
    void this.ctx.storage.put("bucket", decision.state);

    return new Response(
      JSON.stringify({
        allowed: decision.allowed,
        remaining: decision.remaining,
        retryAfterSeconds: decision.retryAfterSeconds,
        resetAt: decision.resetAt,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
}
