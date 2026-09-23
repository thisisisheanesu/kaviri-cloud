// Every byte this Worker sends back to a caller leaves through this file.
//
// The reason it is centralised: a GitHub Action that receives an HTML error page reports
// "expected JSON, got <!DOCTYPE html>", which tells the person reading the log nothing at
// all about what went wrong. An HTML body can arrive from a WAF challenge in front of us,
// which README.md deals with, or from a Worker that threw and let the runtime answer,
// which this file deals with. There is no code path here that can produce anything but
// JSON, including the catch-all around the router.

export const DOCS_ERRORS = "https://kaviri.dev/docs/api#errors";

/** The stable error codes of docs/API.md, plus the two additions noted in README.md. */
export type ErrorCode =
  | "unauthorized"
  | "key_revoked"
  | "not_found"
  | "gone"
  | "script_invalid"
  | "options_invalid"
  | "unknown_field"
  | "idempotency_conflict"
  | "limit_exceeded"
  | "rate_limited"
  | "job_not_cancellable"
  | "job_not_ready"
  | "request_too_large"
  | "org_ambiguous"
  | "internal"
  | "unavailable";

/**
 * A failure with a status and a stable code already decided.
 *
 * Thrown rather than returned so that a check deep inside request parsing does not have
 * to thread a result type back out through every caller, and caught in exactly one place.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    detail?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

export const unauthorized = (message: string) => new ApiError(401, "unauthorized", message);
export const notFound = (message = "no such resource for this caller") =>
  new ApiError(404, "not_found", message);
export const scriptInvalid = (message: string, detail?: Record<string, unknown>) =>
  new ApiError(422, "script_invalid", message, detail);
export const optionsInvalid = (message: string, detail?: Record<string, unknown>) =>
  new ApiError(422, "options_invalid", message, detail);
export const unknownField = (field: string, where: string) =>
  new ApiError(422, "unknown_field", `unknown field ${field} in ${where}`, { field });

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  // Nothing this API returns is cacheable by a shared cache: a job body changes every
  // couple of seconds and an artifact response carries a credential in a redirect.
  "cache-control": "no-store",
  // A browser playground on another origin is a first class caller, and a preflight that
  // fails looks to it exactly like the service being down.
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "X-Kaviri-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Location",
  // A proxy that guesses at the content type of a JSON error is a proxy that can turn it
  // into something a client will not parse.
  "x-content-type-options": "nosniff",
};

export function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(BASE_HEADERS);
  headers.set("X-Kaviri-Request-Id", requestId);
  for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The one error body shape, at every endpoint including 401 and 500.
 *
 * `detail` is omitted rather than set to null when there is nothing structured to say,
 * because a caller that branches on its presence should not have to also test for null.
 */
export function errorBody(code: ErrorCode, message: string, requestId: string, detail?: Record<string, unknown>) {
  const error: Record<string, unknown> = { code, message, request_id: requestId, docs: DOCS_ERRORS };
  if (detail !== undefined) {
    // Reordered so the shape matches the example in docs/API.md, where detail sits
    // between message and request_id. Purely cosmetic, and cheap to keep right.
    return {
      error: { code, message, detail, request_id: requestId, docs: DOCS_ERRORS },
    };
  }
  return { error };
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return jsonResponse(err.status, errorBody(err.code, err.message, requestId, err.detail), requestId, err.headers);
  }
  // Anything that reaches here is a defect rather than a caller mistake, so the caller is
  // told only that it is ours and given the request id to quote. The detail goes to the
  // log, where it belongs.
  console.error("unhandled error", requestId, err);
  return jsonResponse(500, errorBody("internal", "an unexpected error occurred on our side", requestId), requestId);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID for the request id.
 *
 * Sortable by time, which is what makes a support request quotable: two ids from the same
 * customer sort into the order the requests actually happened in, and a log search over a
 * window is a range rather than a scan.
 */
export function ulid(now: number = Date.now(), random: () => number = Math.random): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD.charAt(Math.floor(random() * 32));
  return time + rand;
}
