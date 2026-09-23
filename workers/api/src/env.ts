// The bindings and settings this Worker runs on.
//
// Everything secret is read from the environment at runtime and never written to a file
// that ships. wrangler.toml holds the names and the tunable numbers, and nothing else.

export interface Env {
  CACHE: KVNamespace;
  RATE_LIMIT: DurableObjectNamespace;
  RENDER_QUEUE: Queue<RenderQueueMessage>;

  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_JWT_SECRET: string;

  APP_RPC_SCHEMA: string;

  /**
   * Where artifact links point: the dl Worker's origin, for example
   * https://dl.kaviri.dev. Configuration rather than anything derived from the incoming
   * request, so a forged Host header cannot aim a customer's link elsewhere.
   */
  DL_ORIGIN: string;
  /**
   * The HMAC secret dl verifies with. It must be byte for byte the same value in both
   * Workers, or every link this one mints is a 403 from that one.
   */
  DL_SIGNING_KEY: string;

  SERVICE_VERSION: string;
  RATE_SUBMIT_PER_MIN: string;
  RATE_POLL_PER_MIN: string;
  MAX_BODY_BYTES: string;
  MAX_SOURCE_BYTES: string;
  KEY_CACHE_TTL_SECONDS: string;
  ENTITLEMENTS_CACHE_TTL_SECONDS: string;
  IDEMPOTENCY_CACHE_TTL_SECONDS: string;
  SIGNED_URL_TTL_SECONDS: string;
}

/**
 * The nudge sent to the fleet when a take is accepted.
 *
 * It carries an id and not the script. The database is still the queue: lease_next_job is
 * what hands out work and what enforces concurrency, so a message that never arrives
 * costs latency rather than a lost take, and a message delivered twice leases once.
 */
export interface RenderQueueMessage {
  job_id: string;
  org_id: string;
  enqueued_at: string;
}

/** A setting that must parse, because a typo in wrangler.toml should not mean no limit. */
export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
