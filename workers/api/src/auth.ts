// Who is asking, and what this Worker is allowed to do on their behalf.
//
// Two kinds of caller, one header. A machine presents an API key, which the edge resolves
// to an org and then swaps for a short-lived token that carries the org claim. A human
// presents a Supabase session JWT, which is passed straight through to Postgres, because
// Postgres is what verifies it and org_members is what decides which orgs they are in.
//
// The key itself never travels past the edge, and nothing here holds a service role key.

import { sha256Hex } from "./canonical";
import type { Env } from "./env";
import { intVar } from "./env";
import { ApiError, notFound, unauthorized } from "./http";
import { mintOrgToken, mintResolverToken, readJwtPayload } from "./jwt";
import { Postgrest } from "./pg";

/** The shape of a presented machine key: kv_, eight base32 characters, and a secret. */
export const API_KEY_SHAPE = /^kv_[a-z2-7]{8}_[A-Za-z0-9_-]{16,128}$/;

export interface Caller {
  kind: "key" | "user";
  orgId: string;
  /** The api_keys row id for a machine caller, or the empty string for a human. */
  keyId: string;
  /** The auth.users id for a human caller, if there is one. */
  userId: string | null;
  db: Postgrest;
}

interface CachedKey {
  org_id: string;
  key_id: string;
}

/**
 * Resolve an API key, KV first.
 *
 * This is the line the owner asked for by name: without it, every poll in every CI job in
 * the world is a query against Postgres just to learn something that has not changed
 * since the key was issued. The cache is keyed by the SHA-256 of the presented string,
 * which is the same value the database stores, so a cache dump is no more useful than a
 * database dump.
 *
 * A key that does not resolve is cached too, for a shorter time. Garbage traffic with a
 * well formed but unknown key would otherwise be a database round trip per request, which
 * is a denial of service with no attacker skill in it at all.
 */
export async function resolveApiKey(env: Env, presented: string): Promise<CachedKey | null> {
  const digest = await sha256Hex(presented);
  const cacheKey = `key:${digest}`;

  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached !== null) {
    const hit = cached as CachedKey & { miss?: boolean };
    return hit.miss ? null : { org_id: hit.org_id, key_id: hit.key_id };
  }

  const resolver = new Postgrest(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, await mintResolverToken(env.SUPABASE_JWT_SECRET));
  const rows = await resolver.select("rpc/verify_api_key", {
    method: "POST",
    schema: env.APP_RPC_SCHEMA,
    body: { p_presented: presented },
  });

  const row = rows[0] as { key_id?: unknown; org_id?: unknown } | undefined;
  if (!row || typeof row.org_id !== "string" || typeof row.key_id !== "string") {
    await env.CACHE.put(cacheKey, JSON.stringify({ miss: true }), { expirationTtl: 30 });
    return null;
  }

  const resolved: CachedKey = { org_id: row.org_id, key_id: row.key_id };
  await env.CACHE.put(cacheKey, JSON.stringify(resolved), {
    expirationTtl: intVar(env.KEY_CACHE_TTL_SECONDS, 60),
  });
  return resolved;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) {
    throw unauthorized("this endpoint needs an Authorization: Bearer credential");
  }
  return match[1].trim();
}

/**
 * The org a human caller is speaking for.
 *
 * A machine caller never needs this: its key was issued for exactly one org. A human can
 * be in several, so they either name one with X-Kaviri-Org or they are in exactly one and
 * it is inferred. Guessing between two would mean filing a take against the wrong
 * customer, which is worse than an error message.
 */
async function resolveUserOrg(db: Postgrest, requested: string | null): Promise<string> {
  if (requested !== null && requested !== "") {
    const rows = await db.select(`org_members?select=org_id&org_id=eq.${encodeURIComponent(requested)}&limit=1`);
    if (rows.length === 0) throw notFound("no such org for this caller");
    return requested;
  }
  const rows = (await db.select("org_members?select=org_id&limit=2")) as { org_id: string }[];
  if (rows.length === 0) throw notFound("this account is not a member of any org");
  if (rows.length > 1) {
    throw new ApiError(
      400,
      "org_ambiguous",
      "this account is in more than one org; name one with the X-Kaviri-Org header",
    );
  }
  return rows[0]!.org_id;
}

/**
 * Authenticate, and hand back a database client already scoped to the caller's org.
 *
 * Told apart by shape, not by a second header, because the Action, the playground and a
 * curl one liner all send the same header and only one of them knows what it is holding.
 */
export async function authenticate(request: Request, env: Env): Promise<Caller> {
  const token = bearer(request);

  if (API_KEY_SHAPE.test(token)) {
    const resolved = await resolveApiKey(env, token);
    if (resolved === null) {
      // One answer for a key that never existed and a key that was revoked or expired.
      // The database cannot tell this Worker which it was without a second lookup whose
      // only purpose would be to tell an attacker something.
      throw new ApiError(401, "key_revoked", "that API key is not valid; it may have been revoked or have expired");
    }
    const jwt = await mintOrgToken(resolved.org_id, resolved.key_id, env.SUPABASE_JWT_SECRET);
    return {
      kind: "key",
      orgId: resolved.org_id,
      keyId: resolved.key_id,
      userId: null,
      db: new Postgrest(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, jwt),
    };
  }

  const payload = readJwtPayload(token);
  if (payload === null) {
    throw unauthorized("the Authorization header is neither an API key nor a session token");
  }
  // Passed through unverified on purpose. Postgres verifies the signature, and a second
  // verification here would be a second place that can be wrong about the same secret.
  const db = new Postgrest(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, token);
  const orgId = await resolveUserOrg(db, request.headers.get("x-kaviri-org"));
  return {
    kind: "user",
    orgId,
    keyId: "",
    userId: typeof payload["sub"] === "string" ? payload["sub"] : null,
    db,
  };
}
