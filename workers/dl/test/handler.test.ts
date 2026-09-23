// The handler is exercised with a stub bucket and no Cloudflare runtime. Everything it
// uses is a web standard, which is deliberate: a delivery path whose awkward cases can
// only be tested by deploying it does not get tested.

import { describe, expect, it } from "vitest";

import worker, { type ArtifactBucket, type Ctx, type Env } from "../src/index";
import { mintSignedUrl } from "../src/sign";

const SECRET = "the download signing secret";
const ORIGIN = "https://dl.kaviri.test";
const KEY = "a/d30/8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/video.mp4";
const ETAG = '"6b1fc0a9"';

const CONTENT = new Uint8Array(1000);
for (let i = 0; i < CONTENT.length; i += 1) CONTENT[i] = i % 256;

const ctx: Ctx = { waitUntil: () => undefined };

function bucket(contentType = "video/mp4", key = KEY): ArtifactBucket {
  const meta = { size: CONTENT.length, httpEtag: ETAG, httpMetadata: { contentType } };
  return {
    async head(k) {
      return k === key ? { ...meta } : null;
    },
    async get(k, options) {
      if (k !== key) return null;
      const slice = options?.range
        ? CONTENT.slice(options.range.offset, options.range.offset + options.range.length)
        : CONTENT;
      return { ...meta, body: new Response(slice).body };
    },
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return { ARTIFACTS: bucket(), DL_SIGNING_KEY: SECRET, ...overrides };
}

async function signedUrl(ttlSeconds = 300, key = KEY): Promise<string> {
  const { url } = await mintSignedUrl(ORIGIN, { key, ttlSeconds, secret: SECRET });
  return url;
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("routing", () => {
  it("answers a health check without touching the bucket or the secret", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/healthz`),
      { ARTIFACTS: bucket(), DL_SIGNING_KEY: "" },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "kaviri-dl" });
  });

  it("refuses a write method and says what it accepts", async () => {
    const response = await worker.fetch(new Request(await signedUrl(), { method: "PUT" }), env(), ctx);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("answers a CORS preflight, because the playground fetches takes with the Fetch API", async () => {
    const response = await worker.fetch(new Request(await signedUrl(), { method: "OPTIONS" }), env(), ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-headers")).toContain("Range");
  });

  it("refuses to serve at all when the signing key is missing, rather than verifying against nothing", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl()),
      { ARTIFACTS: bucket(), DL_SIGNING_KEY: "" },
      ctx,
    );

    expect(response.status).toBe(500);
  });
});

describe("the signature gate", () => {
  it("rejects an unsigned path", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/${KEY}`), env(), ctx);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("link_invalid");
  });

  it("rejects a forged signature with one answer for every kind of forgery", async () => {
    const url = await signedUrl();
    const forged = url.replace("video.mp4", "telemetry.json");
    const response = await worker.fetch(new Request(forged), env(), ctx);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("link_invalid");
  });

  it("tells an expired link apart, because that is the one a customer can fix", async () => {
    const { url } = await mintSignedUrl(ORIGIN, {
      key: KEY,
      ttlSeconds: 1,
      secret: SECRET,
      now: Math.floor(Date.now() / 1000) - 3600,
    });
    const response = await worker.fetch(new Request(url), env(), ctx);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("link_expired");
  });

  it("never caches an error", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/nope`), env(), ctx);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("404s a valid signature over an object that is no longer there", async () => {
    const url = await signedUrl(300, "a/d7/8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/video.mp4");
    const response = await worker.fetch(new Request(url), env(), ctx);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });
});

describe("serving the whole object", () => {
  it("returns the bytes with the headers a player and a cache both need", async () => {
    const response = await worker.fetch(new Request(await signedUrl()), env(), ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(response.headers.get("content-disposition")).toBe('inline; filename="video.mp4"');
    expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+, immutable$/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT);
  });

  it("caps the browser cache lifetime at the remaining life of the link", async () => {
    const response = await worker.fetch(new Request(await signedUrl(120)), env(), ctx);
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);

    expect(maxAge).toBeGreaterThan(100);
    expect(maxAge).toBeLessThanOrEqual(120);
  });

  it("answers HEAD with the metadata and no body", async () => {
    const response = await worker.fetch(new Request(await signedUrl(), { method: "HEAD" }), env(), ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.body).toBeNull();
  });

  it("returns 304 when the client already has the object", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl(), { headers: { "if-none-match": ETAG } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(ETAG);
  });

  it("serves an unexpected content type as an opaque download", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl()),
      env({ ARTIFACTS: bucket("text/html") }),
      ctx,
    );

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("ranges, which is what makes Safari play the video at all", () => {
  it("answers the two byte probe with a 206 and a Content-Range", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl(), { headers: { range: "bytes=0-1" } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-1/1000");
    expect(response.headers.get("content-length")).toBe("2");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT.slice(0, 2));
  });

  it("answers a seek into the middle of the file", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl(), { headers: { range: "bytes=500-599" } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 500-599/1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT.slice(500, 600));
  });

  it("answers a suffix range, which is how a player finds the moov atom", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl(), { headers: { range: "bytes=-100" } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 900-999/1000");
  });

  it("answers an unsatisfiable range with 416 and the real size", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl(), { headers: { range: "bytes=5000-6000" } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
  });

  it("falls back to the whole object for a multi range request", async () => {
    const response = await worker.fetch(
      new Request(await signedUrl(), { headers: { range: "bytes=0-1,5-6" } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("1000");
  });

  it("still checks the signature before honouring a range", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/${KEY}`, { headers: { range: "bytes=0-1" } }),
      env(),
      ctx,
    );

    expect(response.status).toBe(403);
  });
});
