// The JSON guarantee, asserted rather than claimed.
//
// README.md used to state that every response is JSON and then offer a manual checklist of
// the Cloudflare settings that could break it. A claim nothing executes is a claim that
// stops being true without anybody noticing, and the failure it hides is expensive: a
// GitHub Action handed an HTML body reports "expected JSON, got <!DOCTYPE html>" and there
// is nothing in the Worker's log to debug, because the Worker never ran.
//
// This file is the half of that guarantee that lives in the code. It drives every route in
// the table, not a list somebody remembered to keep up to date, under every failure this
// Worker can be pushed into, and asserts the same property the edge check asserts against
// the deployed service: the first byte of the body is a brace. The other half, the WAF and
// bot settings in front of the Worker, is asserted by scripts/smoke-json.sh and the
// json-guarantee workflow, because no test running inside the process can see it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RenderQueueMessage } from "../src/env";
import { ROUTES, route } from "../src/index";
import { resetFallbackBuckets } from "../src/ratelimit";

const ORG = "22222222-2222-4222-a222-222222222222";
const KEY_ID = "11111111-1111-4111-a111-111111111111";
const JOB = "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44";
const API_KEY = "kv_7f3k4x2m_aG9sZFRoaXNJc0Fub3RoZXJSYW5kb21TZWNyZXQ";

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

type Upstream = "healthy" | "throws" | "throws-a-string" | "html-502" | "empty-body";
type Limiter = "healthy" | "throws";

let upstream: Upstream = "healthy";
let limiter: Limiter = "healthy";

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

function fakeKV() {
  const store = new Map<string, string>();
  return {
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
  };
}

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    RATE_LIMIT: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          if (limiter === "throws") throw new Error("the durable object is unreachable");
          return new Response(
            JSON.stringify({ allowed: true, remaining: 59, retryAfterSeconds: 0, resetAt: 1758623045 }),
          );
        },
      }),
    },
    RENDER_QUEUE: {
      send: async (_message: RenderQueueMessage) => undefined,
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
    RATE_DEGRADED_PERCENT: "20",
    MAX_BODY_BYTES: "1048576",
    MAX_SOURCE_BYTES: "4096",
    KEY_CACHE_TTL_SECONDS: "60",
    ENTITLEMENTS_CACHE_TTL_SECONDS: "60",
    IDEMPOTENCY_CACHE_TTL_SECONDS: "86400",
    SIGNED_URL_TTL_SECONDS: "300",
  } as unknown as Env;
}

function jsonOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  upstream = "healthy";
  limiter = "healthy";
  resetFallbackBuckets();
  // The logs this suite provokes are deliberate. Silencing them keeps a failed assertion
  // findable in the output instead of buried under a hundred stack traces.
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL) => {
      if (upstream === "throws") throw new Error("connection refused");
      // A throwable that is not an Error at all. errorResponse has to survive this, and a
      // `err.message` written without a guard would itself throw inside the catch block,
      // which is exactly how a Worker ends up letting the runtime answer with HTML.
      if (upstream === "throws-a-string") throw "connection refused";
      // What a proxy, a load balancer or Supabase itself answers with when it is unwell.
      // The point of this case is that an HTML body arriving from upstream must not become
      // an HTML body going out.
      if (upstream === "html-502") {
        return new Response("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      }
      if (upstream === "empty-body") return new Response("", { status: 200 });

      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/rest/v1/")) return new Response("{}", { status: 200 });
      if (url.includes("/rpc/verify_api_key")) return jsonOf([{ key_id: KEY_ID, org_id: ORG }]);
      if (url.includes("/rpc/effective_entitlements")) return jsonOf([ENTITLEMENTS]);
      if (url.includes("/rpc/submit_job")) return jsonOf(JOB_ROW);
      if (url.includes("/rpc/request_cancel")) return jsonOf("cancelled");
      if (url.includes("/projects?")) return jsonOf([{ default_options: {} }]);
      if (url.includes("/render_jobs?id=eq.")) {
        return jsonOf([{ ...JOB_ROW, projects: { slug: "web" }, artifacts: [] }]);
      }
      if (url.includes("/render_jobs?")) return jsonOf([]);
      if (url.includes("/v_org_usage_month")) return jsonOf([]);
      return jsonOf({ code: "PGRST116", message: "unexpected call in a test" }, 400);
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The assertion, in one place, so that every case below checks literally the same property
 * that scripts/smoke-json.sh checks against the deployed service.
 */
async function expectJson(response: Response, where: string): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  const context = `${where}: status ${response.status}, content-type ${contentType || "(none)"}, body starts ${JSON.stringify(text.slice(0, 60))}`;

  expect(contentType, context).toContain("application/json");
  expect(text.slice(0, 1), context).toBe("{");

  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(text);
  }, context).not.toThrow();
  return parsed;
}

/** A concrete path for a route pattern, with a real uuid wherever the table wants an id. */
function pathFor(pattern: string[]): string {
  return "/v1/" + pattern.map((segment) => (segment.startsWith(":") ? JOB : segment)).join("/");
}

function requestFor(
  pattern: string[],
  method: string,
  init: { auth?: boolean; body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.auth !== false) headers["authorization"] = `Bearer ${API_KEY}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  // A GET may not carry a body, which the Request constructor enforces, so a body aimed at
  // a GET route is sent as a POST to the same path instead. That is still the case worth
  // covering: a caller posting nonsense at a read endpoint must get JSON back.
  const usable = init.body !== undefined && (method === "GET" || method === "HEAD") ? "POST" : method;
  return new Request(`https://api.kaviri.dev${pathFor(pattern)}`, { method: usable, headers, body: init.body });
}

const HOSTILE_BODY = '{"project": "web", "script": [ this is not json';

describe("every route in the table answers JSON, whatever is wrong", () => {
  // Driven off ROUTES rather than a list written by hand. Adding a route to src/index.ts
  // adds it to this suite on the same commit, which is what makes the guarantee survive
  // people rather than depending on them.
  it("covers the whole table, and the table is not empty", () => {
    expect(ROUTES.length).toBeGreaterThan(0);
  });

  for (const candidate of ROUTES) {
    const where = `${candidate.method} ${pathFor(candidate.pattern)}`;

    it(`${where} with no credential`, async () => {
      const response = await route(requestFor(candidate.pattern, candidate.method, { auth: false }), makeEnv(), ctx, "REQ");
      const body = (await expectJson(response, where)) as { error?: { code?: string } };
      expect(response.status).toBe(401);
      expect(body.error?.code).toBe("unauthorized");
    });

    it(`${where} when the database is unreachable`, async () => {
      upstream = "throws";
      const response = await route(requestFor(candidate.pattern, candidate.method), makeEnv(), ctx, "REQ");
      await expectJson(response, where);
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it(`${where} when the database throws something that is not an Error`, async () => {
      upstream = "throws-a-string";
      const response = await route(requestFor(candidate.pattern, candidate.method), makeEnv(), ctx, "REQ");
      await expectJson(response, where);
    });

    it(`${where} when upstream answers with an HTML 502`, async () => {
      upstream = "html-502";
      const response = await route(requestFor(candidate.pattern, candidate.method), makeEnv(), ctx, "REQ");
      const text = await response.clone().text();
      expect(text).not.toContain("<!DOCTYPE");
      await expectJson(response, where);
    });

    it(`${where} when upstream answers 200 with an empty body`, async () => {
      upstream = "empty-body";
      const response = await route(requestFor(candidate.pattern, candidate.method), makeEnv(), ctx, "REQ");
      await expectJson(response, where);
    });

    it(`${where} when the rate limiting Durable Object is unreachable`, async () => {
      // Compared against the same request with a healthy limiter rather than against a
      // hardcoded status, so this asserts the thing it means: degrading changes nothing a
      // caller can see except the extra header. A hardcoded status would quietly become an
      // assertion about the fakes instead.
      const healthy = await route(requestFor(candidate.pattern, candidate.method), makeEnv(), ctx, "REQ");
      await expectJson(healthy, `${where} (limiter healthy)`);

      limiter = "throws";
      const response = await route(requestFor(candidate.pattern, candidate.method), makeEnv(), ctx, "REQ");
      await expectJson(response, where);
      expect(response.status).toBe(healthy.status);
      // The degraded signal has to survive onto error responses too, because those are the
      // ones a caller is reading while something is wrong.
      expect(response.headers.get("X-RateLimit-Mode")).toBe("degraded");
      expect(healthy.headers.get("X-RateLimit-Mode")).toBeNull();
      expect(response.headers.get("X-RateLimit-Limit")).not.toBeNull();
    });

    it(`${where} with a body that is not JSON`, async () => {
      const response = await route(
        requestFor(candidate.pattern, candidate.method, { body: HOSTILE_BODY }),
        makeEnv(),
        ctx,
        "REQ",
      );
      await expectJson(response, where);
    });

    it(`${where} with a method the table does not have`, async () => {
      const response = await route(requestFor(candidate.pattern, "PATCH"), makeEnv(), ctx, "REQ");
      await expectJson(response, where);
      expect([404, 405]).toContain(response.status);
    });
  }
});

describe("the paths that are not in the table", () => {
  it("answers /v1/health as JSON when the database is up", async () => {
    const response = await route(new Request("https://api.kaviri.dev/v1/health"), makeEnv(), ctx, "REQ");
    expect(response.status).toBe(200);
    await expectJson(response, "GET /v1/health");
  });

  it("answers /v1/health as JSON when the database is down, which is when it matters", async () => {
    upstream = "throws";
    const response = await route(new Request("https://api.kaviri.dev/v1/health"), makeEnv(), ctx, "REQ");
    expect(response.status).toBe(503);
    await expectJson(response, "GET /v1/health (database down)");
  });

  it("answers an unversioned path as JSON", async () => {
    const response = await route(new Request("https://api.kaviri.dev/"), makeEnv(), ctx, "REQ");
    await expectJson(response, "GET /");
  });

  it("answers a path that looks like a browser visit as JSON", async () => {
    // A human, or a bot manager's probe, arriving with an HTML Accept header. Content
    // negotiation is not a thing this API does, and this is the assertion that says so.
    const response = await route(
      new Request("https://api.kaviri.dev/v1/health", { headers: { accept: "text/html" } }),
      makeEnv(),
      ctx,
      "REQ",
    );
    await expectJson(response, "GET /v1/health with Accept: text/html");
  });

  it("answers a deeply nested unknown path as JSON", async () => {
    const response = await route(
      new Request("https://api.kaviri.dev/v1/jobs/" + JOB + "/artifact/extra/segments"),
      makeEnv(),
      ctx,
      "REQ",
    );
    await expectJson(response, "GET a too-long path");
  });

  it("answers an OPTIONS preflight with no body at all, which is the one allowed exception", async () => {
    const response = await route(
      new Request("https://api.kaviri.dev/v1/jobs", { method: "OPTIONS" }),
      makeEnv(),
      ctx,
      "REQ",
    );
    expect(response.status).toBe(204);
    // A 204 carries no body, so there is nothing for a caller to try to parse. That is why
    // it is exempt from the brace rule rather than an oversight in it.
    expect(await response.text()).toBe("");
  });
});
