// Signed artifact paths.
//
// The signature lives in the PATH and not in a query string. Three reasons, in order of
// how much they cost when you get them wrong:
//
// 1. Caches key on the path far more reliably than on the query. Cloudflare can be told
//    to ignore query strings, some corporate proxies strip them outright, and GitHub's
//    camo proxy rewrites the URL it fetches. A credential that can be dropped in transit
//    is a credential that produces intermittent 403s nobody can reproduce.
// 2. A path-signed URL is one string with no reserved characters to escape, so it
//    survives being pasted into a README, a Slack message and a YAML file unchanged.
// 3. The download Worker can verify it with nothing but an HMAC secret. It makes no
//    database call and holds no database credential, which matters because it is the one
//    public, unauthenticated surface in the system.
//
// Shape, and it is deliberately readable so a support conversation can be had about it:
//
//   /1/<expiry base36>/<signature base64url>/<object key>
//
// The signature covers the version, the expiry segment exactly as it appears, and the
// decoded object key. Signing the expiry segment as text rather than as a number means a
// re-encoded expiry ("0abc" for "abc") is a different message and fails, so there is only
// one valid spelling of any given link.

const TEXT = new TextEncoder();

/**
 * Bumped only when the canonical message changes. Verification accepts exactly one
 * version at a time, because accepting an older one indefinitely means a signing bug is
 * never actually retired.
 */
export const SIGNED_PATH_VERSION = "1";

/** One year. Long enough for a README embed to outlive a release cycle. */
export const MAX_TTL_SECONDS = 31_536_000;

/** R2 allows 1024 bytes of key. Refusing a longer one here fails at mint, not at fetch. */
export const MAX_KEY_LENGTH = 1024;

export type VerifyFailure =
  | "malformed"
  | "unsupported_version"
  | "invalid_key"
  | "bad_signature"
  | "expired";

export type VerifyResult =
  | { ok: true; key: string; expiresAt: number }
  | { ok: false; reason: VerifyFailure };

/**
 * Importing an HMAC key is not free and the Worker does it on every request with the same
 * one or two secrets, so the imported keys are kept for the life of the isolate. The
 * secret is already resident in env; this Map does not widen its exposure.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let existing = keyCache.get(secret);
  if (!existing) {
    existing = crypto.subtle.importKey(
      "raw",
      TEXT.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, existing);
  }
  return existing;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compares in time that does not depend on where the first difference is. A fast
 * mismatch is a measurable one, and a measurable one can be walked byte by byte into a
 * forged signature given enough attempts.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The object key is the last field of the signed message, so a key containing a newline
 * could move the field boundary and make two different links produce the same signature.
 * Control characters are rejected rather than escaped, because no key this service mints
 * contains one and a key that does is a bug upstream worth surfacing.
 */
export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  if (key.includes("//")) return false;
  // "." and ".." are legal R2 key segments but never ours, and allowing them would mean
  // reasoning about path normalisation in every cache and proxy between here and the eye.
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

function canonicalMessage(expirySegment: string, key: string): string {
  return `kaviri-dl/${SIGNED_PATH_VERSION}\n${expirySegment}\n${key}`;
}

async function signature(secret: string, expirySegment: string, key: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    TEXT.encode(canonicalMessage(expirySegment, key)),
  );
  return base64url(new Uint8Array(mac));
}

/** Percent-encodes each segment while leaving the separators alone, so the key stays readable. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function decodeKey(segments: string[]): string | null {
  try {
    return segments.map(decodeURIComponent).join("/");
  } catch {
    // A stray percent sign. Malformed rather than unauthorised, but the caller collapses
    // both to the same answer so a prober cannot tell the difference.
    return null;
  }
}

export interface MintOptions {
  /** The R2 object key, exactly as it was written to the bucket. */
  key: string;
  /** Seconds from now. Clamped to MAX_TTL_SECONDS, and to at least one second. */
  ttlSeconds: number;
  /** The current HMAC secret. Never the previous one: that exists only to verify. */
  secret: string;
  /** Unix seconds. Injected by the tests; production passes nothing. */
  now?: number;
  /**
   * An upper bound tighter than MAX_TTL_SECONDS, which is how a caller keeps a link from
   * outliving the artifact it points at. The API worker passes the artifact's remaining
   * retention here.
   */
  maxTtlSeconds?: number;
}

export interface MintedPath {
  path: string;
  /** Unix seconds, so a caller can put an `expires_at` in its own response body. */
  expiresAt: number;
}

export async function mintSignedPath(options: MintOptions): Promise<MintedPath> {
  if (!isValidObjectKey(options.key)) {
    throw new Error(`refusing to sign an invalid object key: ${JSON.stringify(options.key)}`);
  }
  if (!options.secret) {
    throw new Error("refusing to sign without a signing key");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ceiling = Math.min(options.maxTtlSeconds ?? MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  const ttl = Math.max(1, Math.min(Math.floor(options.ttlSeconds), ceiling));
  const expiresAt = now + ttl;
  const expirySegment = expiresAt.toString(36);
  const sig = await signature(options.secret, expirySegment, options.key);

  return {
    path: `/${SIGNED_PATH_VERSION}/${expirySegment}/${sig}/${encodeKey(options.key)}`,
    expiresAt,
  };
}

/**
 * Mints an absolute URL. `origin` is the download host, for example
 * `https://dl.kaviri.dev`, and is configuration rather than something derived from the
 * incoming request, so a Host header cannot redirect a customer's link somewhere else.
 */
export async function mintSignedUrl(
  origin: string,
  options: MintOptions,
): Promise<{ url: string; expiresAt: number }> {
  const minted = await mintSignedPath(options);
  return { url: `${origin.replace(/\/+$/, "")}${minted.path}`, expiresAt: minted.expiresAt };
}

/**
 * Verifies a path against every secret it is given, current first. Two secrets are
 * accepted so that rotating the signing key does not break links already pasted into
 * READMEs: deploy the new key as current and the old one as previous, wait out the
 * longest TTL in circulation, then drop the previous one.
 */
export async function verifySignedPath(
  pathname: string,
  secrets: readonly string[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const segments = pathname.replace(/^\/+/, "").split("/");
  if (segments.length < 4) return { ok: false, reason: "malformed" };

  const [version, expirySegment, sig, ...keySegments] = segments;
  // Narrowed rather than asserted. The length check above already guarantees all three
  // are present, but the api Worker compiles this file under noUncheckedIndexedAccess and
  // a non-null assertion in the one function that decides whether a request is authorised
  // is exactly the place not to tell the compiler to trust us.
  if (version === undefined || expirySegment === undefined || sig === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (version !== SIGNED_PATH_VERSION) return { ok: false, reason: "unsupported_version" };
  if (!/^[0-9a-z]{1,12}$/.test(expirySegment)) return { ok: false, reason: "malformed" };
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: "malformed" };

  const key = decodeKey(keySegments);
  if (key === null || !isValidObjectKey(key)) return { ok: false, reason: "invalid_key" };

  const usable = secrets.filter((secret) => Boolean(secret));
  if (usable.length === 0) return { ok: false, reason: "bad_signature" };

  let matched = false;
  for (const secret of usable) {
    // Every secret is tried even after a match, so the time this loop takes does not
    // reveal which key signed the link.
    const expected = await signature(secret, expirySegment, key);
    matched = timingSafeEqual(expected, sig) || matched;
  }
  if (!matched) return { ok: false, reason: "bad_signature" };

  const expiresAt = Number.parseInt(expirySegment, 36);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };
  // Expiry is checked after the signature so that an unsigned guess cannot be used to
  // probe whether a key exists by the shape of the error it gets back.
  if (expiresAt <= now) return { ok: false, reason: "expired" };

  return { ok: true, key, expiresAt };
}
