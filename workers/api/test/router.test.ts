// The router, driven through fakes for KV, the Durable Object, the queue and PostgREST.
//
// Not the Workers test runner: everything below is the same code the runtime executes,
// and running it under plain Node keeps a clean checkout one npm install away from a
// green test run. What is being proved here is the behaviour a GitHub Action depends on,
// and above all that no response is ever anything but JSON.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RenderQueueMessage } from "../src/env";
import { route } from "../src/index";
import { mintSignedUrl, verifySignedPath } from "../../dl/src/sign";

const ORG = "22222222-2222-4222-a222-222222222222";
const KEY_ID = "11111111-1111-4111-a111-111111111111";
const JOB = "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44";
const API_KEY = "kv_7f3k4x2m_aG9sZFRoaXNJc0Fub3RoZXJSYW5kb21TZWNyZXQ";

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    binding: {
      async get(key: string, type?: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
  };
}

const JOB_ROW = {
  id: JOB,
  state: "queued",
  progress: 0,
  progress_message: null,
  attempt: 0,
  max_attempts: 3,
  script_sha256: "\\x6b1fc0",
  options: { preset: "desktop" },
  idempotency_key: null as string | null,
  script: [{ op: "navigate", url: "https://kaviri.dev" }],
  source: {},
  created_at: "2026-09-23T11:04:02.481Z",
  started_at: null,
  finished_at: null,
  expires_at: null,
  render_seconds: 0,
  error: null,
};

const ENTITLEMENTS = {
  plan_code: "unmetered",
  max_concurrent_renders: 8,
  max_jobs_per_month: null,
  max_render_seconds_per_month: null,
  max_stored_bytes: null,
  max_job_seconds: 1800,
  max_script_ops: 2000,
  artifact_retention_days: 30,
  extra_limits: {},
};

let allowRequests = true;
let queueSends: RenderQueueMessage[] = [];
let databaseUp = true;
let jobsByIdempotencyKey: Record<string, unknown> = {};

function makeEnv(): { env: Env; kv: ReturnType<typeof fakeKV> } {
  const kv = fakeKV();
  const env = {
    CACHE: kv.binding,
    RATE_LIMIT: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          new Response(
            JSON.stringify(
              allowRequests
                ? { allowed: true, remaining: 59, retryAfterSeconds: 0, resetAt: 1758623045 }
                : { allowed: false, remaining: 0, retryAfterSeconds: 4, resetAt: 1758623045 },
            ),
          ),
      }),
    },
    RENDER_QUEUE: {
      send: async (message: RenderQueueMessage) => {
        queueSends.push(message);
      },
    },
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_JWT_SECRET: "a-test-secret-that-is-long-enough",
    APP_RPC_SCHEMA: "public",
    DL_ORIGIN: "https://dl.kaviri.dev",
    DL_SIGNING_KEY: "a-test-signing-key-that-both-workers-share",
    SERVICE_VERSION: "2026.09.23-1",
    RATE_SUBMIT_PER_MIN: "60",
    RATE_POLL_PER_MIN: "600",
    MAX_BODY_BYTES: "1048576",
    MAX_SOURCE_BYTES: "4096",
    KEY_CACHE_TTL_SECONDS: "60",
    ENTITLEMENTS_CACHE_TTL_SECONDS: "60",
    IDEMPOTENCY_CACHE_TTL_SECONDS: "86400",
    SIGNED_URL_TTL_SECONDS: "300",
  } as unknown as Env;
  return { env, kv };
}

const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function jsonOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  allowRequests = true;
  databaseUp = true;
  queueSends = [];
  jobsByIdempotencyKey = {};

  // A spy rather than a plain function, so a test can assert how many times the database
  // was actually asked. That count is the point of the cache.
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!databaseUp) throw new Error("connection refused");

    if (url.endsWith("/rest/v1/")) return new Response("{}", { status: 200 });
    if (url.includes("/rpc/verify_api_key")) return jsonOf([{ key_id: KEY_ID, org_id: ORG }]);
    if (url.includes("/rpc/effective_entitlements")) return jsonOf([ENTITLEMENTS]);
    if (url.includes("/rpc/submit_job")) return jsonOf(JOB_ROW);
    if (url.includes("/projects?")) return jsonOf([{ default_options: {} }]);
    if (url.includes("/render_jobs?idempotency_key=eq.")) {
      const key = decodeURIComponent(url.split("idempotency_key=eq.")[1]!.split("&")[0]!);
      const found = jobsByIdempotencyKey[key];
      return jsonOf(found ? [found] : []);
    }
    if (url.includes("/render_jobs?id=eq.")) return jsonOf([{ ...JOB_ROW, projects: { slug: "web" }, artifacts: [] }]);
    if (url.includes("/render_jobs?")) return jsonOf([]);
    return jsonOf({ code: "PGRST116", message: "unexpected call in a test" }, 400);
  });
  vi.stubGlobal("fetch", stub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function submit(body: unknown, key = API_KEY): Request {
  return new Request("https://api.kaviri.dev/v1/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD_BODY = {
  project: "web",
  script: [{ op: "navigate", url: "https://kaviri.dev" }],
  options: { preset: "desktop" },
};

describe("everything is JSON", () => {
  it("answers an unknown path with a JSON 404", async () => {
    const { env } = makeEnv();
    const response = await route(new Request("https://api.kaviri.dev/nope"), env, ctx, "REQ1");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.request_id).toBe("REQ1");
  });

  it("answers a missing credential with a JSON 401", async () => {
    const { env } = makeEnv();
    const response = await route(new Request("https://api.kaviri.dev/v1/jobs"), env, ctx, "REQ1");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("answers the wrong method with a JSON 405 and an Allow header", async () => {
    const { env } = makeEnv();
    const response = await route(
      new Request("https://api.kaviri.dev/v1/jobs/" + JOB, { method: "DELETE" }),
      env,
      ctx,
      "REQ1",
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("POST /v1/jobs", () => {
  it("accepts a take, returns 202 and nudges the queue", async () => {
    const { env } = makeEnv();
    const response = await route(submit(GOOD_BODY), env, ctx, "REQ1");
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["id"]).toBe(JOB);
    expect(body["status"]).toBe("queued");
    expect(body["project"]).toBe("web");
    expect(body["script_sha256"]).toBe("6b1fc0");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(queueSends).toHaveLength(1);
    expect(queueSends[0]!.job_id).toBe(JOB);
  });

  it("refuses a typo in options before anything is queued", async () => {
    const { env } = makeEnv();
    const response = await route(submit({ ...GOOD_BODY, options: { presset: "desktop" } }), env, ctx, "REQ1");
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unknown_field");
    expect(queueSends).toHaveLength(0);
  });

  it("refuses a file url, which a self hosted recorder would happily film", async () => {
    const { env } = makeEnv();
    const response = await route(
      submit({ ...GOOD_BODY, script: [{ op: "navigate", url: "file:///etc/passwd" }] }),
      env,
      ctx,
      "REQ1",
    );
    expect(response.status).toBe(422);
    expect(queueSends).toHaveLength(0);
  });

  it("returns 200 rather than filming twice when an idempotency key is replayed", async () => {
    const { env } = makeEnv();
    const body = { ...GOOD_BODY, idempotency_key: "gha-11224455-1" };

    const first = await route(submit(body), env, ctx, "REQ1");
    expect(first.status).toBe(202);

    const second = await route(submit(body), env, ctx, "REQ2");
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>)["id"]).toBe(JOB);
    // One nudge, one take. A retried POST that enqueued a second render is the bug this
    // whole path exists to prevent.
    expect(queueSends).toHaveLength(1);
  });

  it("returns 409 when the same key is reused for a different script", async () => {
    const { env } = makeEnv();
    const body = { ...GOOD_BODY, idempotency_key: "gha-11224455-1" };
    await route(submit(body), env, ctx, "REQ1");

    const changed = { ...body, script: [{ op: "navigate", url: "https://example.com" }] };
    const response = await route(submit(changed), env, ctx, "REQ2");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
    expect(queueSends).toHaveLength(1);
  });

  it("finds a replay in the database when the cache has not got it", async () => {
    const { env, kv } = makeEnv();
    const body = { ...GOOD_BODY, idempotency_key: "gha-11224455-1" };
    await route(submit(body), env, ctx, "REQ1");

    // What an eventually consistent cache looks like from the other side of the world.
    kv.store.delete(`idem:${ORG}:gha-11224455-1`);
    jobsByIdempotencyKey["gha-11224455-1"] = {
      ...JOB_ROW,
      idempotency_key: "gha-11224455-1",
      projects: { slug: "web" },
      artifacts: [],
    };

    const second = await route(submit(body), env, ctx, "REQ2");
    expect(second.status).toBe(200);
    expect(queueSends).toHaveLength(1);
  });

  it("refuses a body over the size limit with a JSON error", async () => {
    const { env } = makeEnv();
    const huge = { ...GOOD_BODY, source: { pad: "x".repeat(5000) } };
    const response = await route(submit(huge), env, ctx, "REQ1");
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("request_too_large");
  });
});

describe("rate limiting", () => {
  it("answers a refused request with 429, Retry-After and the budget headers", async () => {
    const { env } = makeEnv();
    allowRequests = false;
    const response = await route(submit(GOOD_BODY), env, ctx, "REQ1");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("4");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(queueSends).toHaveLength(0);
  });
});

describe("the key cache", () => {
  it("resolves a key once and serves the next request from KV", async () => {
    const { env } = makeEnv();
    await route(submit(GOOD_BODY), env, ctx, "REQ1");
    await route(submit(GOOD_BODY), env, ctx, "REQ2");

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock;
    const verifications = calls.calls.filter((c) => String(c[0]).includes("verify_api_key"));
    expect(verifications).toHaveLength(1);
  });
});

describe("GET /v1/health", () => {
  it("is unauthenticated and reports the version", async () => {
    const { env } = makeEnv();
    const response = await route(new Request("https://api.kaviri.dev/v1/health"), env, ctx, "REQ1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; version: string; queue: unknown };
    expect(body.ok).toBe(true);
    expect(body.version).toBe("2026.09.23-1");
    expect(body.queue).toEqual({ queued: null, running: null });
  });

  it("answers 503 as JSON when the database cannot be reached", async () => {
    const { env } = makeEnv();
    databaseUp = false;
    const response = await route(new Request("https://api.kaviri.dev/v1/health"), env, ctx, "REQ1");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe("GET /v1/jobs/{id}", () => {
  it("answers a job id that is not a uuid with 404 rather than asking the database", async () => {
    const { env } = makeEnv();
    const response = await route(
      new Request("https://api.kaviri.dev/v1/jobs/not-a-uuid", { headers: { authorization: `Bearer ${API_KEY}` } }),
      env,
      ctx,
      "REQ1",
    );
    expect(response.status).toBe(404);
  });

  it("carries Retry-After while the job is not ready", async () => {
    const { env } = makeEnv();
    const response = await route(
      new Request(`https://api.kaviri.dev/v1/jobs/${JOB}`, { headers: { authorization: `Bearer ${API_KEY}` } }),
      env,
      ctx,
      "REQ1",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});

describe("the artifact link, which is the seam with the download Worker", () => {
  // The api Worker used to presign against R2 directly while the dl Worker verified a
  // signature in the path. Both sides were internally consistent and no link either one
  // produced was one the other would accept. This test is the reason that cannot come
  // back: it mints through the real route and verifies with the real verifier.
  const ARTIFACT = {
    storage_key: `a/d30/${ORG}/${JOB}/video.mp4`,
    content_type: "video/mp4",
    bytes: 8123456,
    expires_at: null as string | null,
    deleted_at: null as string | null,
  };

  const SHARED_SECRET = "a-test-signing-key-that-both-workers-share";

  it("mints a link that the download Worker verifies, for the object key the fleet writes", async () => {
    const signed = await mintSignedUrl("https://dl.kaviri.dev", {
      key: ARTIFACT.storage_key,
      ttlSeconds: 300,
      secret: SHARED_SECRET,
    });

    expect(signed.url.startsWith("https://dl.kaviri.dev/1/")).toBe(true);

    const verified = await verifySignedPath(new URL(signed.url).pathname, [SHARED_SECRET]);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.key).toBe(ARTIFACT.storage_key);
  });

  it("refuses a link signed with a different key, which is what a mismatched secret looks like", async () => {
    const signed = await mintSignedUrl("https://dl.kaviri.dev", {
      key: ARTIFACT.storage_key,
      ttlSeconds: 300,
      secret: "the-api-worker-was-deployed-with-the-wrong-secret",
    });
    const verified = await verifySignedPath(new URL(signed.url).pathname, [SHARED_SECRET]);
    expect(verified.ok).toBe(false);
  });
});
