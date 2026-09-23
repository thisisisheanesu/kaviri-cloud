// The object key layout, and the retention class that is encoded into it.
//
// This module is the single definition of where an artifact lives in the bucket. The
// render worker imports it to decide what to upload to, the download Worker never needs
// it (it serves whatever key the signature covers), and the R2 lifecycle rules in
// infra/r2-lifecycle.json are written against the prefixes it produces.
//
// WHY THE RETENTION CLASS IS IN THE KEY
//
// R2 lifecycle rules filter on a key prefix and nothing else. There is no per-object
// expiry header, no tag-based rule and no way to ask R2 to consult a database. So the
// only way to have the bucket itself guarantee that a free tier take does not sit there
// for a year is to put the retention in the prefix and write one rule per class.
//
// That backstop matters more than it looks. The authoritative expiry is in Postgres:
// expire_due_artifacts marks the row and a sweeper deletes the object. But the sweeper
// can only delete objects it has a row for, and the objects that actually run a bill up
// are the ones with no row at all: an upload that finished a moment before the box died,
// a retry whose completion never landed, an abandoned multipart. Nothing in the database
// knows those exist. The lifecycle rules do not care, because they act on the prefix.
//
// The class is stamped at upload time from the org's artifact_retention_days. An org that
// upgrades afterwards keeps the old class on takes already filmed, which is a deliberate
// simplification: the alternative is copying objects between prefixes on a plan change,
// and a copy that half fails leaves an artifact in two classes or none.

/** Ordered shortest first, because retentionClassFor picks the first class that fits. */
export const RETENTION_CLASSES = [
  { name: "d7", days: 7 },
  { name: "d30", days: 30 },
  { name: "d90", days: 90 },
  { name: "d365", days: 365 },
] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number]["name"] | "keep";

/** Every prefix the bucket is allowed to contain, which is what the setup script asserts. */
export const ARTIFACT_PREFIX = "a";

/**
 * Rounds a retention in days UP to a class, so an object is never swept before the
 * retention the customer was promised. A null or non-positive retention means unlimited,
 * which is the "keep" class and has no lifecycle rule at all.
 */
export function retentionClassFor(days: number | null | undefined): RetentionClass {
  if (days === null || days === undefined || !Number.isFinite(days) || days <= 0) return "keep";
  for (const candidate of RETENTION_CLASSES) {
    if (days <= candidate.days) return candidate.name;
  }
  return "keep";
}

/**
 * How long the lifecycle rule for a class waits. One day longer than the class itself,
 * because R2 lifecycle expiry works in whole days from the upload and the database sweep
 * is the thing that should normally do the deleting. The extra day keeps the bucket from
 * removing an object while a customer's still-valid link points at it.
 */
export function lifecycleDaysFor(cls: Exclude<RetentionClass, "keep">): number {
  const found = RETENTION_CLASSES.find((candidate) => candidate.name === cls);
  if (!found) throw new Error(`unknown retention class: ${cls}`);
  return found.days + 1;
}

export type ArtifactKind = "video" | "poster" | "telemetry" | "log";

/** Matches the artifact_kind enum in supabase/migrations/0006_artifacts.sql. */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["video", "poster", "telemetry", "log"];

const DEFAULT_EXTENSION: Record<ArtifactKind, string> = {
  video: "mp4",
  poster: "jpg",
  telemetry: "json",
  log: "txt",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArtifactKeyInput {
  orgId: string;
  jobId: string;
  kind: ArtifactKind;
  /** The org's effective artifact_retention_days, or null for unlimited. */
  retentionDays: number | null;
  /** Overrides the default for the kind, for a PNG poster or a .jsonl log. */
  extension?: string;
}

/**
 * Builds the key for one artifact of one job.
 *
 *   a/<class>/<org id>/<job id>/<kind>.<ext>
 *
 * One key per (job, kind), matching the unique constraint on the artifacts table, so a
 * retry that re-renders the same take overwrites its predecessor instead of leaving an
 * object behind that no row points at and no customer can delete.
 *
 * The org and job ids are in the key because a bucket listing is the last resort when
 * something has gone wrong, and a listing of opaque hashes helps nobody. Neither id is a
 * secret: the signature is what authorises the fetch, not the difficulty of guessing the
 * path.
 */
export function artifactKey(input: ArtifactKeyInput): string {
  if (!UUID.test(input.orgId)) throw new Error(`org id is not a uuid: ${input.orgId}`);
  if (!UUID.test(input.jobId)) throw new Error(`job id is not a uuid: ${input.jobId}`);
  if (!ARTIFACT_KINDS.includes(input.kind)) throw new Error(`unknown artifact kind: ${input.kind}`);

  const extension = (input.extension ?? DEFAULT_EXTENSION[input.kind]).replace(/^\.+/, "");
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error(`unusable extension: ${extension}`);

  const cls = retentionClassFor(input.retentionDays);
  return `${ARTIFACT_PREFIX}/${cls}/${input.orgId.toLowerCase()}/${input.jobId.toLowerCase()}/${input.kind}.${extension}`;
}

export interface ParsedArtifactKey {
  retentionClass: RetentionClass;
  orgId: string;
  jobId: string;
  kind: ArtifactKind;
  extension: string;
}

/**
 * The inverse, for the sweeper and for support. Returns null rather than throwing,
 * because it is routinely handed keys from a bucket listing that predate a layout change.
 */
export function parseArtifactKey(key: string): ParsedArtifactKey | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== ARTIFACT_PREFIX) return null;

  const [, cls, orgId, jobId, filename] = parts;
  // The length check above guarantees these, but this function's whole job is to be
  // handed keys it does not trust, so it narrows rather than asserting.
  if (cls === undefined || orgId === undefined || jobId === undefined || filename === undefined) {
    return null;
  }
  const known = cls === "keep" || RETENTION_CLASSES.some((candidate) => candidate.name === cls);
  if (!known || !UUID.test(orgId) || !UUID.test(jobId)) return null;

  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  const kind = filename.slice(0, dot) as ArtifactKind;
  if (!ARTIFACT_KINDS.includes(kind)) return null;

  return {
    retentionClass: cls as RetentionClass,
    orgId,
    jobId,
    kind,
    extension: filename.slice(dot + 1),
  };
}
