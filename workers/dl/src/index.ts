// kaviri-dl: artifact delivery.
//
// One job. Verify a signature that is in the path, then stream bytes out of R2.
//
// WHY R2 AND NOT SUPABASE STORAGE
//
// The product is a demo video you embed. An embed in a README is fetched through GitHub's
// camo proxy, on every page view, by every visitor and every crawler, with no referrer to
// rate limit against and no session to attribute it to. That is unbounded egress on an
// object that never changes. R2 charges nothing for egress, so the bill for a take that
// gets popular is storage plus operations, both of which are bounded and both of which we
// control. Every other candidate bills the one line item that has no ceiling.
//
// WHY THIS WORKER HOLDS NO DATABASE CREDENTIAL
//
// It is the only public, unauthenticated surface in the system, so it is the one worth
// keeping empty. It has an HMAC secret and a bucket binding. It cannot read a script, a
// key hash, an org or a usage row, because it has no way to reach them. Everything it
// needs to know is in the URL it was handed, and the signature is what makes that
// trustworthy.

import { baseHeaders, decideContent, errorResponse, requestIdFor } from "./http";
import { contentRange, parseRange, toR2Range, unsatisfiableContentRange } from "./range";
import { verifySignedPath } from "./sign";

// Structural types rather than an import of the Workers type package, so that every
// module here can be exercised in a plain test runner with a stub bucket. R2Bucket
// satisfies these as it stands.

export interface ObjectHead {
  size: number;
  httpEtag: string;
  etag?: string;
  uploaded?: Date;
  httpMetadata?: { contentType?: string; cacheControl?: string };
}

export interface ObjectBody extends ObjectHead {
  body: ReadableStream | null;
}

export interface ArtifactBucket {
  head(key: string): Promise<ObjectHead | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<ObjectBody | null>;
}

export interface Env {
  ARTIFACTS: ArtifactBucket;
  /** The current HMAC secret. A wrangler secret, never a var, and never in a file. */
  DL_SIGNING_KEY: string;
  /** Accepted during a rotation and then removed. See sign.ts. */
  DL_SIGNING_KEY_PREVIOUS?: string;
  /** Seconds a full object may sit in the Cloudflare cache. Default one hour. */
  DL_EDGE_CACHE_SECONDS?: string;
  /** Objects above this are streamed straight through and never cached. Default 64 MiB. */
  DL_CACHE_MAX_BYTES?: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const ONE_HOUR = 3600;
const SIXTY_FOUR_MIB = 64 * 1024 * 1024;
const ONE_YEAR = 31_536_000;

function numberFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The cache key, and the reason the signature being in the path is worth the trouble.
 *
 * Every signed URL for one object is a different string, because each carries its own
 * expiry. Keying the cache on the request URL would therefore make every fresh link a
 * cold miss and every popular video a repeated read from the bucket. Keying on the object
 * instead means one cached copy serves every link to it. This is safe only because
 * verification happens before the lookup: nothing reaches this function without a valid
 * signature, so the cache is not an authorisation bypass.
 *
 * The key is a real URL under the service's own hostname rather than a synthetic one, so
 * a takedown can be done with a Cloudflare purge by URL.
 */
function objectCacheKey(host: string, key: string): Request {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new Request(`https://${host}/__object/${encoded}`, { method: "GET" });
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const normalise = (value: string) => value.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) => normalise(candidate) === normalise(etag));
}

/**
 * What the browser is told to do with the bytes.
 *
 * `immutable` is honest here: a key is written once by complete_job and a retry that
 * re-renders the take overwrites the whole object under the same key only before anybody
 * has been given a link to it. What a customer holds a link to never changes underneath
 * them.
 *
 * The max age is capped at the remaining life of the signature, so a cached copy can
 * never outlive the link that fetched it. Without that cap a five minute link would leave
 * a year long copy in a shared proxy.
 */
function clientCacheControl(expiresAt: number, now: number): string {
  const remaining = Math.max(0, Math.min(expiresAt - now, ONE_YEAR));
  return `public, max-age=${remaining}, immutable`;
}

function corsPreflight(requestId: string): Response {
  const headers = baseHeaders(requestId);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, If-None-Match, If-Range");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(null, { status: 204, headers });
}

export default {
  /**
   * The outermost catch, and the only reason this wrapper exists.
   *
   * `handle` below already catches what it expects to go wrong. This catches what it does
   * not. A Worker that lets an exception escape is answered by the Cloudflare runtime with
   * an HTML error page carrying a 1101, and a customer whose embedded video broke, or a
   * script parsing this endpoint, gets markup where the error envelope should be. The api
   * Worker has had this guarantee since it was written; this one serves the only public
   * unauthenticated surface in the system and had it only for the part of the request after
   * the signature verified.
   */
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      const requestId = request.headers.get("cf-ray") ?? "unknown";
      console.log(
        JSON.stringify({
          at: "dl",
          event: "unhandled",
          request_id: requestId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return errorResponse(500, "internal", "the request could not be handled", requestId);
    }
  },
};

async function handle(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return corsPreflight(requestId);

  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = errorResponse(
      405,
      "method_not_allowed",
      "this host serves artifacts and accepts GET, HEAD and OPTIONS only",
      requestId,
    );
    response.headers.set("Allow", "GET, HEAD, OPTIONS");
    return response;
  }

  // Unauthenticated on purpose, and it touches neither the bucket nor a secret, so it
  // answers even when the signing key is missing. That is what makes it useful during a
  // deploy that got the secrets wrong.
  if (url.pathname === "/" || url.pathname === "/healthz") {
    const headers = baseHeaders(requestId);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify({ ok: true, service: "kaviri-dl" }), { status: 200, headers });
  }

  if (!env.DL_SIGNING_KEY) {
    // Refusing loudly beats verifying against an empty secret, which would accept a
    // signature anybody could compute.
    console.log(JSON.stringify({ at: "dl", event: "misconfigured", request_id: requestId }));
    return errorResponse(500, "internal", "artifact delivery is not configured", requestId);
  }

  const now = Math.floor(Date.now() / 1000);
  const verified = await verifySignedPath(
    url.pathname,
    [env.DL_SIGNING_KEY, env.DL_SIGNING_KEY_PREVIOUS ?? ""],
    now,
  );

  if (!verified.ok) {
    if (verified.reason === "expired") {
      return errorResponse(
        403,
        "link_expired",
        "this download link has expired; request a fresh one from the job's artifact endpoint",
        requestId,
      );
    }
    // Every other failure is one status and one code. The expiry is the only thing
    // kept separate, and only once the signature has already been proved good, so a
    // caller cannot use the difference between "wrong" and "too late" to learn whether
    // a key they guessed at exists. The reason in detail is about the shape of the URL
    // rather than about the object, which is what makes it safe to hand back and useful
    // in a support conversation.
    return errorResponse(403, "link_invalid", "this download link is not valid", requestId, {
      reason: verified.reason,
    });
  }

  const { key, expiresAt } = verified;

  try {
    return await serve(request, env, ctx, { key, expiresAt, now, requestId, host: url.host });
  } catch (error) {
    console.log(
      JSON.stringify({
        at: "dl",
        event: "error",
        request_id: requestId,
        key,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return errorResponse(500, "internal", "the artifact could not be read", requestId);
  }
}

interface ServeContext {
  key: string;
  expiresAt: number;
  now: number;
  requestId: string;
  host: string;
}

async function serve(request: Request, env: Env, ctx: Ctx, s: ServeContext): Promise<Response> {
  const rangeHeader = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");

  // HEAD and ranged GETs both need the size before anything else can be decided, and
  // neither is worth a cache entry: HEAD has no body to cache and a 206 cannot be stored
  // in the Cache API at all.
  if (request.method === "HEAD" || rangeHeader) {
    const head = await env.ARTIFACTS.head(s.key);
    if (!head) return notFound(s.requestId, s.key);

    if (etagMatches(ifNoneMatch, head.httpEtag)) return notModified(s, head.httpEtag);

    if (request.method === "HEAD") {
      const headers = objectHeaders(s, head, head.size);
      headers.set("Content-Length", String(head.size));
      return new Response(null, { status: 200, headers });
    }

    const parsed = parseRange(rangeHeader, head.size);

    if (parsed.kind === "unsatisfiable") {
      const response = errorResponse(
        416,
        "range_not_satisfiable",
        "the requested byte range lies outside this artifact",
        s.requestId,
        { bytes: head.size },
      );
      response.headers.set("Content-Range", unsatisfiableContentRange(head.size));
      response.headers.set("Accept-Ranges", "bytes");
      return response;
    }

    if (parsed.kind === "partial") {
      const object = await env.ARTIFACTS.get(s.key, { range: toR2Range(parsed.start, parsed.end) });
      if (!object) return notFound(s.requestId, s.key);

      const length = parsed.end - parsed.start + 1;
      const headers = objectHeaders(s, object, head.size);
      headers.set("Content-Length", String(length));
      headers.set("Content-Range", contentRange(parsed.start, parsed.end, head.size));
      log(s, 206, length);
      return new Response(object.body, { status: 206, headers });
    }
    // A Range header this server declines to honour falls through to the full body path.
  }

  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = objectCacheKey(s.host, s.key);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const etag = hit.headers.get("etag") ?? "";
      if (etagMatches(ifNoneMatch, etag)) return notModified(s, etag);

      // The cached entry carries the edge lifetime. The copy handed to the client carries
      // the link's remaining lifetime instead, which is shorter and specific to this
      // request, so the two are rewritten apart here rather than being allowed to leak
      // into each other.
      const headers = new Headers(hit.headers);
      for (const [name, value] of baseHeaders(s.requestId)) headers.set(name, value);
      headers.set("Cache-Control", clientCacheControl(s.expiresAt, s.now));
      headers.set("Accept-Ranges", "bytes");
      headers.set("X-Kaviri-Cache", "hit");
      log(s, 200, Number(headers.get("content-length") ?? 0), "hit");
      return new Response(hit.body, { status: 200, headers });
    }
  }

  const object = await env.ARTIFACTS.get(s.key);
  if (!object) return notFound(s.requestId, s.key);

  if (etagMatches(ifNoneMatch, object.httpEtag)) return notModified(s, object.httpEtag);

  const headers = objectHeaders(s, object, object.size);
  headers.set("Content-Length", String(object.size));

  const edgeSeconds = numberFromEnv(env.DL_EDGE_CACHE_SECONDS, ONE_HOUR);
  const cacheMaxBytes = numberFromEnv(env.DL_CACHE_MAX_BYTES, SIXTY_FOUR_MIB);
  const worthCaching = Boolean(cache) && object.size > 0 && object.size <= cacheMaxBytes && edgeSeconds > 0;

  const response = new Response(object.body, { status: 200, headers });

  if (worthCaching && cache) {
    // The stored copy gets the edge lifetime. Cloning before the client's Cache-Control
    // is written is what keeps the two apart; a clone taken afterwards would store the
    // link's short expiry and make the cache almost useless.
    const storable = response.clone();
    storable.headers.set("Cache-Control", `public, max-age=${edgeSeconds}`);
    storable.headers.delete("X-Kaviri-Request-Id");
    ctx.waitUntil(cache.put(cacheKey, storable));
  }

  response.headers.set("Cache-Control", clientCacheControl(s.expiresAt, s.now));
  response.headers.set("X-Kaviri-Cache", worthCaching ? "miss" : "bypass");
  log(s, 200, object.size, worthCaching ? "miss" : "bypass");
  return response;
}

function objectHeaders(s: ServeContext, object: ObjectHead, fullSize: number): Headers {
  const headers = baseHeaders(s.requestId);
  const decided = decideContent(object.httpMetadata?.contentType, s.key);

  headers.set("Content-Type", decided.contentType);
  headers.set("Content-Disposition", decided.disposition);
  headers.set("ETag", object.httpEtag);
  // Advertised on every response, not only on the partial ones, because a media element
  // decides whether a source is seekable from the 200 it got first.
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", clientCacheControl(s.expiresAt, s.now));
  headers.set("X-Kaviri-Artifact-Bytes", String(fullSize));
  return headers;
}

function notModified(s: ServeContext, etag: string): Response {
  const headers = baseHeaders(s.requestId);
  headers.set("ETag", etag);
  headers.set("Cache-Control", clientCacheControl(s.expiresAt, s.now));
  headers.set("Accept-Ranges", "bytes");
  return new Response(null, { status: 304, headers });
}

/**
 * A key that verified but has no object is almost always retention having swept it, since
 * a signature cannot exist for a key that was never minted. It is still a 404 rather than
 * the 410 the API returns, because this Worker has no row to tell the two apart and
 * guessing at "gone" for what might be a failed upload would be a worse answer.
 */
function notFound(requestId: string, key: string): Response {
  console.log(JSON.stringify({ at: "dl", event: "miss", request_id: requestId, key }));
  return errorResponse(404, "not_found", "no such artifact", requestId);
}

function log(s: ServeContext, status: number, bytes: number, cache = "n/a"): void {
  console.log(
    JSON.stringify({ at: "dl", event: "served", request_id: s.requestId, key: s.key, status, bytes, cache }),
  );
}
