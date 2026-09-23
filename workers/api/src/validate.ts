// Request validation, all of it pure so all of it is testable without a network.
//
// The edge validates before the job is queued because a script that fails on op 4 should
// fail in under a second, not after a box has been leased and Chromium started. The rules
// are the recorder's, taken from kaviri/src/ops.rs, and the edge is not allowed to be
// more permissive than the recorder is. It is allowed to be stricter in exactly one
// place, and that place is which URLs a shared fleet will open.

import { ApiError, optionsInvalid, scriptInvalid, unknownField } from "./http";

export const OPS = [
  "navigate",
  "click",
  "type",
  "scroll",
  "wait",
  "mark",
  "start_recording",
  "stop_recording",
] as const;

export const PRESETS = [
  "desktop",
  "tiktok",
  "reels",
  "shorts",
  "square",
  "landscape",
  "readme",
  "phone",
] as const;

export const BACKGROUNDS = [
  "auto",
  "none",
  "dusk",
  "dawn",
  "tide",
  "moss",
  "ember",
  "slate",
  "linen",
  "mesh-cool",
  "mesh-warm",
] as const;

export const CURSORS = ["auto", "none", "arrow", "hand", "text"] as const;

const JOB_FIELDS = new Set(["project", "script", "options", "source", "idempotency_key"]);
const OPTION_FIELDS = new Set([
  "preset",
  "background",
  "scale",
  "out_width",
  "out_height",
  "cursor",
  "cursor_scale",
  "telemetry",
]);

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]?$/;

export interface SubmitBody {
  project: string;
  script: unknown[];
  options: Record<string, unknown>;
  source: Record<string, unknown>;
  idempotency_key: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A duration field on an op, matching duration_ms in the recorder: finite and not negative. */
function checkDuration(op: Record<string, unknown>, field: string, index: number): void {
  const v = op[field];
  if (v === undefined || v === null) return;
  if (!isFiniteNumber(v) || v < 0) {
    throw scriptInvalid(`op ${index}: ${field} must be a finite non-negative number of milliseconds`, {
      op_index: index,
      field,
    });
  }
}

/**
 * Which URLs the hosted service will open.
 *
 * This is the one rule deliberately stricter than the self hosted recorder, which happily
 * films a local file because the person running it chose the file. On a shared fleet,
 * file:///etc/passwd and http://169.254.169.254/ are not takes, they are exfiltration,
 * and the box that would open them is holding other tenants work.
 */
export function checkNavigateUrl(raw: unknown, index: number): void {
  if (typeof raw !== "string" || raw.length === 0) {
    throw scriptInvalid(`op ${index}: navigate needs an absolute http or https url`, { op_index: index });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw scriptInvalid(`op ${index}: navigate url is not absolute`, { op_index: index });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw scriptInvalid(`op ${index}: the hosted service opens http and https only, not ${url.protocol}`, {
      op_index: index,
      protocol: url.protocol,
    });
  }
  if (isNonRoutableHost(url.hostname)) {
    throw scriptInvalid(`op ${index}: the hosted service will not open the non-routable host ${url.hostname}`, {
      op_index: index,
      host: url.hostname,
    });
  }
}

/**
 * Hosts a render box must never be pointed at.
 *
 * Literal addresses are the ones worth refusing here. A name that resolves to a private
 * address is refused on the box, at connect time, because a name check at the edge is a
 * DNS answer that can differ from the one the box gets a second later.
 */
export function isNonRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(":")) {
    // Loopback, unique local and link local, which is where a cloud metadata service and
    // a neighbour container both live.
    if (host === "::1" || host === "::") return true;
    if (/^f[cd]/.test(host) || /^fe80/.test(host)) return true;
    // An IPv4-mapped address wearing an IPv6 spelling is still the address it maps to.
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped && mapped[1]) return isNonRoutableHost(mapped[1]);
  }
  return false;
}

/** One op, by the recorder's rules. Throws the 422 the caller should see. */
export function validateOp(raw: unknown, index: number): void {
  if (!isPlainObject(raw)) {
    throw scriptInvalid(`op ${index}: every element of a script is an object`, { op_index: index });
  }
  const op = raw["op"];
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
    throw scriptInvalid(`op ${index}: unknown op ${JSON.stringify(op)}`, { op_index: index, ops: OPS });
  }

  switch (op) {
    case "navigate": {
      checkNavigateUrl(raw["url"], index);
      checkDuration(raw, "timeout_ms", index);
      break;
    }
    case "click": {
      const hasSelector = typeof raw["selector"] === "string" && raw["selector"].length > 0;
      const hasPoint = isFiniteNumber(raw["x"]) && isFiniteNumber(raw["y"]);
      if (!hasSelector && !hasPoint) {
        throw scriptInvalid(`op ${index}: click needs a selector, or both x and y`, { op_index: index });
      }
      break;
    }
    case "type": {
      if (typeof raw["text"] !== "string") {
        throw scriptInvalid(`op ${index}: type needs text`, { op_index: index });
      }
      if (raw["selector"] !== undefined && typeof raw["selector"] !== "string") {
        throw scriptInvalid(`op ${index}: type selector must be a CSS selector string`, { op_index: index });
      }
      checkDuration(raw, "typewriter_ms", index);
      break;
    }
    case "scroll": {
      const y = raw["y"];
      if (!isFiniteNumber(y) || y < 0) {
        throw scriptInvalid(
          `op ${index}: scroll needs y, a finite non-negative number of CSS pixels from the top of the document`,
          { op_index: index },
        );
      }
      if (raw["smooth"] !== undefined && typeof raw["smooth"] !== "boolean") {
        throw scriptInvalid(`op ${index}: scroll smooth must be a boolean`, { op_index: index });
      }
      break;
    }
    case "wait": {
      const hasMs = raw["ms"] !== undefined && raw["ms"] !== null;
      const hasSelector = raw["selector"] !== undefined && raw["selector"] !== null;
      if (hasMs && hasSelector) {
        throw scriptInvalid(`op ${index}: wait takes ms or selector, never both`, { op_index: index });
      }
      if (!hasMs && !hasSelector) {
        throw scriptInvalid(`op ${index}: wait needs ms or selector`, { op_index: index });
      }
      if (hasMs) checkDuration(raw, "ms", index);
      if (hasSelector && typeof raw["selector"] !== "string") {
        throw scriptInvalid(`op ${index}: wait selector must be a CSS selector string`, { op_index: index });
      }
      checkDuration(raw, "timeout_ms", index);
      if (raw["visible"] !== undefined && typeof raw["visible"] !== "boolean") {
        throw scriptInvalid(`op ${index}: wait visible must be a boolean`, { op_index: index });
      }
      break;
    }
    case "mark": {
      if (raw["label"] !== undefined && typeof raw["label"] !== "string") {
        throw scriptInvalid(`op ${index}: mark label must be a string`, { op_index: index });
      }
      break;
    }
    default:
      // start_recording and stop_recording are accepted and unnecessary: the service
      // wraps every script in them. Refusing them would break a script that runs both
      // locally and here, which is the whole point of the recorder being the same binary.
      break;
  }
}

export function validateScript(script: unknown): unknown[] {
  if (!Array.isArray(script)) throw scriptInvalid("script must be an array of ops");
  if (script.length === 0) throw scriptInvalid("script is empty");
  script.forEach(validateOp);
  return script;
}

function checkRange(name: string, value: unknown, min: number, max: number, integer: boolean): void {
  if (!isFiniteNumber(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw optionsInvalid(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`, {
      field: name,
    });
  }
}

/** Options, exactly the set docs/API.md defines. Anything else is a typo worth failing on. */
export function validateOptions(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw optionsInvalid("options must be an object");

  for (const key of Object.keys(raw)) {
    if (!OPTION_FIELDS.has(key)) throw unknownField(key, "options");
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    switch (key) {
      case "preset":
        if (typeof value !== "string" || !(PRESETS as readonly string[]).includes(value)) {
          throw optionsInvalid(`unknown preset ${JSON.stringify(value)}`, { field: "preset", allowed: PRESETS });
        }
        out[key] = value;
        break;
      case "background":
        if (typeof value !== "string" || !(BACKGROUNDS as readonly string[]).includes(value)) {
          throw optionsInvalid(`unknown background ${JSON.stringify(value)}`, {
            field: "background",
            allowed: BACKGROUNDS,
          });
        }
        out[key] = value;
        break;
      case "cursor":
        if (typeof value !== "string" || !(CURSORS as readonly string[]).includes(value)) {
          throw optionsInvalid(`unknown cursor ${JSON.stringify(value)}`, { field: "cursor", allowed: CURSORS });
        }
        out[key] = value;
        break;
      case "scale":
        checkRange("scale", value, 0.5, 4.0, false);
        out[key] = value;
        break;
      case "cursor_scale":
        checkRange("cursor_scale", value, 0.2, 8.0, false);
        out[key] = value;
        break;
      case "out_width":
      case "out_height":
        // Null is meaningful: it is how a caller says to take the preset's own size after
        // a project default set something else.
        if (value === null) {
          out[key] = null;
          break;
        }
        checkRange(key, value, 64, 8192, true);
        out[key] = value;
        break;
      case "telemetry":
        if (typeof value !== "boolean") {
          throw optionsInvalid("telemetry must be a boolean", { field: "telemetry" });
        }
        out[key] = value;
        break;
    }
  }
  return out;
}

/**
 * The POST /v1/jobs body.
 *
 * Unknown fields are rejected rather than ignored so that a typo in `presset` fails
 * loudly in CI instead of quietly rendering the default and producing a video nobody
 * notices is wrong until it is on the README.
 */
export function validateSubmitBody(raw: unknown, maxSourceBytes: number): SubmitBody {
  if (!isPlainObject(raw)) throw scriptInvalid("the request body must be a JSON object");

  for (const key of Object.keys(raw)) {
    if (!JOB_FIELDS.has(key)) throw unknownField(key, "the request body");
  }

  const project = raw["project"];
  if (typeof project !== "string" || !PROJECT_SLUG.test(project)) {
    throw new ApiError(422, "options_invalid", "project must be a slug of 1 to 40 characters from a to z, 0 to 9 and -", {
      field: "project",
    });
  }

  const script = validateScript(raw["script"]);
  const options = validateOptions(raw["options"]);

  let source: Record<string, unknown> = {};
  if (raw["source"] !== undefined && raw["source"] !== null) {
    if (!isPlainObject(raw["source"])) throw optionsInvalid("source must be an object", { field: "source" });
    source = raw["source"];
    const bytes = new TextEncoder().encode(JSON.stringify(source)).length;
    if (bytes > maxSourceBytes) {
      throw new ApiError(413, "request_too_large", `source is ${bytes} bytes and the limit is ${maxSourceBytes}`, {
        field: "source",
        bytes,
        limit: maxSourceBytes,
      });
    }
  }

  let idempotencyKey: string | null = null;
  if (raw["idempotency_key"] !== undefined && raw["idempotency_key"] !== null) {
    const key = raw["idempotency_key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) {
      throw optionsInvalid("idempotency_key must be a string of 8 to 200 characters", { field: "idempotency_key" });
    }
    idempotencyKey = key;
  }

  return { project, script, options, source, idempotency_key: idempotencyKey };
}

/** The GET /v1/jobs query string. Returns what the list query needs, already bounded. */
export function validateListQuery(params: URLSearchParams): {
  project: string | null;
  statuses: string[];
  limit: number;
  cursor: { created_at: string; id: string } | null;
} {
  const project = params.get("project");
  if (project !== null && !PROJECT_SLUG.test(project)) {
    throw optionsInvalid("project must be a slug", { field: "project" });
  }

  const statuses = params.getAll("status");
  const allowed = ["queued", "running", "done", "failed", "cancelled", "expired"];
  for (const s of statuses) {
    if (!allowed.includes(s)) throw optionsInvalid(`unknown status ${JSON.stringify(s)}`, { field: "status", allowed });
  }

  let limit = 20;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw optionsInvalid("limit must be an integer between 1 and 100", { field: "limit" });
    }
    limit = parsed;
  }

  return { project, statuses, limit, cursor: decodeCursor(params.get("cursor")) };
}

/**
 * The list cursor.
 *
 * Keyset over (created_at, id) rather than an offset, so a job submitted while a client
 * is paginating shifts nothing: an offset page two would repeat a row that page one
 * already returned, and a CI log full of duplicates is how that gets noticed.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return base64UrlEncode(JSON.stringify({ c: createdAt, i: id }));
}

export function decodeCursor(raw: string | null): { created_at: string; id: string } | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(raw)) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") throw new Error("shape");
    return { created_at: parsed.c, id: parsed.i };
  } catch {
    throw optionsInvalid("cursor is not one this service issued", { field: "cursor" });
  }
}

export function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
