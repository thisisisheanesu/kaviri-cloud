// Content addressing for idempotency.
//
// Two submissions carrying the same idempotency key must be judged the same or different
// by what they would render, not by how the JSON happened to be spelled. A retry from a
// shell that reserialised the body, or a round trip through Postgres jsonb (which sorts
// object keys and drops duplicates), must not read as a different script.

/** JSON with object keys sorted at every depth, so spelling cannot change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    // undefined is not a JSON value, and JSON.stringify would drop the key silently. It
    // is dropped here too, but deliberately and in one place.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/**
 * What decides whether a reused idempotency key is a retry or a conflict.
 *
 * Only the script and the resolved options go in. `source` is deliberately excluded: a
 * re-run of the same workflow attempt carries a different run id in its provenance while
 * filming exactly the same thing, and refusing that would turn a harmless retry into a
 * 409 nobody can act on.
 */
export function submissionFingerprintInput(script: unknown, options: unknown): string {
  return canonicalJson({ script, options });
}

export async function submissionFingerprint(script: unknown, options: unknown): Promise<string> {
  return sha256Hex(submissionFingerprintInput(script, options));
}

/** PostgREST renders a bytea as the Postgres hex literal. Callers want the digest. */
export function byteaToHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.startsWith("\\x") ? value.slice(2) : value;
}
