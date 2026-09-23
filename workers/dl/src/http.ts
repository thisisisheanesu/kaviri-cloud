// Response construction: the error envelope, the headers that go on everything, and the
// content type policy.

/**
 * The same envelope docs/API.md defines for api.kaviri.dev. A customer hitting a broken
 * link should not have to learn a second error shape because the bytes are served by a
 * different Worker.
 */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    docs: string;
    detail?: Record<string, unknown>;
  };
}

const DOCS = "https://kaviri.dev/docs/api#errors";

/**
 * Headers that belong on every response this Worker makes, including the errors.
 *
 * The CSP is the important one. Object content types are set by the render worker, and if
 * one ever manages to write an HTML file into the bucket, this turns a stored cross site
 * scripting hole on a domain we control into a blank page. `sandbox` with no allow list
 * denies scripts, forms, popups and same origin access in one token.
 */
export function baseHeaders(requestId: string): Headers {
  return new Headers({
    "X-Kaviri-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    // Artifacts are served to anyone holding a valid link, so there is nothing for an
    // origin check to protect. Allowing every origin is what lets the playground fetch a
    // take with the Fetch API and lets a page measure the video it just embedded.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges, X-Kaviri-Request-Id",
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  detail?: Record<string, unknown>,
): Response {
  const headers = baseHeaders(requestId);
  headers.set("Content-Type", "application/json; charset=utf-8");
  // An error is never cached. A 404 cached at the edge outlives the upload that would
  // have fixed it, and a cached 403 outlives the rotation that would have.
  headers.set("Cache-Control", "no-store");

  const body: ErrorBody = { error: { code, message, request_id: requestId, docs: DOCS } };
  if (detail) body.error.detail = detail;

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Content types this Worker will hand back as themselves. Anything else is served as an
 * opaque download.
 *
 * The allow list exists because content_type on the artifacts table is whatever the
 * render worker wrote, and a public host that reflects an arbitrary caller supplied
 * content type is one compromised render box away from serving text/html from
 * dl.kaviri.dev. The CSP above already defangs that; this is the second lock.
 */
const SERVABLE_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "application/json",
  "text/plain",
]);

export interface ContentDecision {
  contentType: string;
  disposition: string;
}

/**
 * Decides what to claim the bytes are and whether a browser may render them in place.
 *
 * Inline is the default because the whole point is a link that plays in a README preview
 * or a pull request comment, and `attachment` turns that into a download prompt.
 */
export function decideContent(rawType: string | undefined, key: string): ContentDecision {
  const filename = sanitiseFilename(key.slice(key.lastIndexOf("/") + 1));
  const declared = ((rawType ?? "").split(";")[0] ?? "").trim().toLowerCase();

  if (SERVABLE_TYPES.has(declared)) {
    const charset = declared === "application/json" || declared === "text/plain" ? "; charset=utf-8" : "";
    return { contentType: `${declared}${charset}`, disposition: `inline; filename="${filename}"` };
  }

  return {
    contentType: "application/octet-stream",
    disposition: `attachment; filename="${filename}"`,
  };
}

/**
 * Content-Disposition is a header, and a filename carrying a quote or a newline would let
 * the key inject one. Keys are validated at mint time too; this is the layer that does
 * not depend on that having happened.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "artifact";
}

/** A request id, preferring Cloudflare's ray id so a log line here joins a log line there. */
export function requestIdFor(request: Request): string {
  const ray = request.headers.get("cf-ray");
  return ray ?? crypto.randomUUID();
}
