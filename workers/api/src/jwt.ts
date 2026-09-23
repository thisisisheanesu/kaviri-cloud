// Minting the short-lived Postgres JWT the edge does its work under.
//
// No component of this system holds a service role key on the request path. The edge
// resolves a presented API key to an org and then mints a token that says only: you are
// the kaviri_api role, you speak for this one org, for the next minute. Every Row Level
// Security policy in the schema is written against that claim, so a mistake in this
// Worker cannot widen a caller past the org its key was issued for.

export interface RoleClaims {
  role: "kaviri_api";
  kaviri_org: string;
  kaviri_key: string;
  iat: number;
  exp: number;
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * The imported HMAC key is cached per isolate.
 *
 * importKey is not free and the alternative is doing it on every single request, which on
 * a poll loop is the most called line in the Worker. The cache is keyed by the secret so
 * a rotated secret does not keep signing with the old one.
 */
function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCache.set(secret, promise);
  return promise;
}

export async function signJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64urlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlText(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

/**
 * A token for one org, valid for a minute.
 *
 * Deliberately short. A token that leaks out of a log line is a token that has already
 * expired by the time anybody reads the log, and nothing in the request path needs to
 * hold one for longer than the request it was minted for.
 */
export function orgTokenClaims(orgId: string, keyId: string, now: number, ttlSeconds = 60): RoleClaims {
  const iat = Math.floor(now / 1000);
  return {
    role: "kaviri_api",
    kaviri_org: orgId,
    kaviri_key: keyId,
    iat,
    exp: iat + ttlSeconds,
    // No sub claim on purpose. app.current_user_id reads sub, and a machine caller that
    // carried one would start satisfying predicates written for a human.
  };
}

export async function mintOrgToken(orgId: string, keyId: string, secret: string, now = Date.now()): Promise<string> {
  return signJwt(orgTokenClaims(orgId, keyId, now) as unknown as Record<string, unknown>, secret);
}

/**
 * A token with the role and no org claim, used for exactly one call: resolving a
 * presented key. app.verify_api_key is granted to kaviri_api and is SECURITY DEFINER, so
 * it needs the role and nothing else, and a token with no org claim cannot read a row of
 * any tenant table if this Worker ever sends it somewhere it should not.
 */
export async function mintResolverToken(secret: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return signJwt({ role: "kaviri_api", iat, exp: iat + 60 }, secret);
}

/** The payload of a Supabase session JWT, read without verifying: Postgres verifies it. */
export function readJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
