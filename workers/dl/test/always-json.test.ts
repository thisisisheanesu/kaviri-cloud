// This Worker serves bytes, but everything that is not bytes is JSON.
//
// It is the only public, unauthenticated surface in the system, so it is the one a broken
// embed, a crawler and a probe all land on, and the one whose errors a person reads while
// something is already going wrong. An HTML error page from here is the same expensive
// failure the api Worker's test/always-json.test.ts exists to prevent: a caller reports
// "expected JSON, got <!DOCTYPE html>" and there is nothing to debug, because in the worst
// case the Worker did not run.
//
// The half this file can prove is that no code path here answers with markup, including the
// paths nobody planned for. The half it cannot prove is the edge in front of the Worker, and
// that is what workers/api/scripts/smoke-json.sh checks against the deployed hostname.

import { describe, expect, it } from "vitest";

import worker, { type ArtifactBucket, type Ctx, type Env } from "../src/index";
import { mintSignedUrl } from "../src/sign";

const SECRET = "the download signing secret";
const ORIGIN = "https://dl.kaviri.test";
const KEY = "a/d30/8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/video.mp4";

const ctx: Ctx = { waitUntil: () => undefined };

const emptyBucket: ArtifactBucket = {
  async head() {
    return null;
  },
  async get() {
    return null;
  },
};

/** A bucket that fails the way a storage backend actually fails, which is mid request. */
const explodingBucket: ArtifactBucket = {
  async head() {
    throw new Error("R2 is having a day");
  },
  async get() {
    throw new Error("R2 is having a day");
  },
};

function env(overrides: Partial<Env> = {}): Env {
  return { ARTIFACTS: emptyBucket, DL_SIGNING_KEY: SECRET, ...overrides };
}

async function expectJson(response: Response, where: string): Promise<void> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const context = `${where}: status ${response.status}, content-type ${contentType || "(none)"}, body starts ${JSON.stringify(text.slice(0, 60))}`;

  expect(contentType, context).toContain("application/json");
  // The same crude assertion the edge check makes, so the two cannot drift into testing
  // different things.
  expect(text.slice(0, 1), context).toBe("{");
  expect(() => JSON.parse(text), context).not.toThrow();
}

async function signedUrl(ttlSeconds = 300): Promise<string> {
  const { url } = await mintSignedUrl(ORIGIN, { key: KEY, ttlSeconds, secret: SECRET });
  return url;
}

describe("every answer that carries a body carries JSON", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["the health endpoint", async () => worker.fetch(new Request(`${ORIGIN}/healthz`), env(), ctx)],
    ["the root path", async () => worker.fetch(new Request(`${ORIGIN}/`), env(), ctx)],
    ["an unsigned path", async () => worker.fetch(new Request(`${ORIGIN}/not-signed-at-all`), env(), ctx)],
    [
      "a path that looks signed and is not",
      async () => worker.fetch(new Request(`${ORIGIN}/1/deadbeef/video.mp4`), env(), ctx),
    ],
    ["an expired link", async () => worker.fetch(new Request(await signedUrl(-60)), env(), ctx)],
    [
      "a valid link to an object that is gone",
      async () => worker.fetch(new Request(await signedUrl()), env(), ctx),
    ],
    [
      "a write method",
      async () => worker.fetch(new Request(await signedUrl(), { method: "PUT" }), env(), ctx),
    ],
    [
      "a Worker deployed without its signing secret",
      async () => worker.fetch(new Request(`${ORIGIN}/1/whatever/video.mp4`), env({ DL_SIGNING_KEY: "" }), ctx),
    ],
    [
      "a bucket that throws",
      async () => worker.fetch(new Request(await signedUrl()), env({ ARTIFACTS: explodingBucket }), ctx),
    ],
    [
      "a browser arriving with an HTML Accept header",
      async () =>
        worker.fetch(new Request(`${ORIGIN}/nope`, { headers: { accept: "text/html" } }), env(), ctx),
    ],
  ];

  for (const [description, run] of cases) {
    it(description, async () => {
      await expectJson(await run(), description);
    });
  }

  it("answers a CORS preflight with no body at all, which is the one allowed exception", async () => {
    const response = await worker.fetch(new Request(await signedUrl(), { method: "OPTIONS" }), env(), ctx);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("the outermost catch", () => {
  // Before this existed, only the part of the request after the signature had verified was
  // inside a try. Anything that threw earlier escaped to the runtime, which answers with an
  // HTML page carrying a 1101 rather than with the error envelope this service documents.
  it("turns an exception thrown before the signature is checked into a JSON 500", async () => {
    // Reading the signing key is the last thing that happens before the signature is
    // verified and the first thing that happens outside any try, so a getter that throws
    // here lands in exactly the gap this catch was added to close.
    const hostile = {
      ARTIFACTS: emptyBucket,
      get DL_SIGNING_KEY(): string {
        throw new Error("the secret binding is not there");
      },
    } as unknown as Env;

    const response = await worker.fetch(new Request(await signedUrl()), hostile, ctx);
    await expectJson(response, "an exception before verification");
    expect(response.status).toBe(500);
  });

  it("still answers JSON when the request carries no cf-ray to build a request id from", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/nope`), env(), ctx);
    await expectJson(response, "no cf-ray header");
  });
});
