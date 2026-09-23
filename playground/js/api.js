/*
 * The hosted service client: the same script, sent to api.kaviri.dev for a real render.
 *
 * Coded against docs/API.md in this repository and nothing else. Where the API grows a field
 * this file does not know about, it ignores it; where a documented field is missing it says so
 * rather than rendering "undefined" at a visitor.
 *
 * On the key. It is typed into the page by whoever owns it, held in memory, and optionally
 * mirrored into sessionStorage so a reload does not lose it. sessionStorage rather than
 * localStorage is the whole point: it dies with the tab, which is the right lifetime for a
 * credential pasted into a playground. It goes into one place, the Authorization header on a
 * request to the API base, and never into a URL, a query string, an error message or any log.
 */

export const DEFAULT_BASE = "https://api.kaviri.dev";

const KEY_SHAPE = /^kv_[a-z2-7]{8}_[A-Za-z0-9_-]{16,}$/;

/**
 * Check a key's shape before spending a request on it.
 *
 * The API documents the format precisely, and a typo caught here is a sentence of explanation
 * instead of a 401 that looks like the service is broken. It cannot tell a revoked key from a
 * live one, and does not pretend to.
 */
export function checkKeyShape(key) {
  const k = (key || "").trim();
  if (!k) return { ok: false, message: "paste a key to send a take" };
  if (!k.startsWith("kv_")) return { ok: false, message: "a kaviri API key starts with kv_" };
  if (!KEY_SHAPE.test(k)) {
    return {
      ok: false,
      message:
        "that is not the shape of a kaviri key: kv_, eight lowercase base32 characters, an " +
        "underscore, then at least sixteen URL-safe characters",
    };
  }
  return { ok: true, prefix: k.slice(0, 11) };
}

class ApiError extends Error {
  constructor(status, body, requestId) {
    const err = body && body.error;
    super((err && err.message) || `the service answered ${status}`);
    this.status = status;
    this.code = (err && err.code) || "unknown";
    this.detail = err && err.detail;
    this.requestId = (err && err.request_id) || requestId || null;
    this.docs = err && err.docs;
  }
}

async function call(base, key, path, init = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    // A failed fetch to a cross-origin API is almost always CORS or the network, and the browser
    // deliberately will not say which. Saying that plainly beats reporting "Failed to fetch".
    throw new ApiError(0, {
      error: {
        code: "unreachable",
        message:
          `could not reach ${base}. Either the network is down, or the service is not allowing ` +
          `requests from this page's origin.`,
      },
    });
  }
  const requestId = res.headers.get("X-Kaviri-Request-Id");
  const retryAfter = Number(res.headers.get("Retry-After")) || null;
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw new ApiError(res.status, body, requestId);
  return { status: res.status, body, requestId, retryAfter };
}

/** POST /v1/jobs. Returns 202 for a new job and 200 when an idempotency key matched. */
export async function submitJob(base, key, payload) {
  return call(base, key, "/v1/jobs", { method: "POST", body: JSON.stringify(payload) });
}

/** GET /v1/jobs/{id}. */
export async function getJob(base, key, id) {
  return call(base, key, `/v1/jobs/${encodeURIComponent(id)}`);
}

/** POST /v1/jobs/{id}/cancel. */
export async function cancelJob(base, key, id) {
  return call(base, key, `/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/**
 * The signed artifact URL.
 *
 * `redirect=false` on purpose: following the 302 from here would drop the Authorization header
 * on some engines and re-send it on others, and neither is a thing to guess about with a
 * credential. The body form hands back a URL that already carries its own signature.
 */
export async function artifactUrl(base, key, id, kind = "video") {
  const { body } = await call(
    base,
    key,
    `/v1/jobs/${encodeURIComponent(id)}/artifact?kind=${encodeURIComponent(kind)}&redirect=false`
  );
  return body;
}

/** GET /v1/usage. Quantities and limits, never prices. */
export async function getUsage(base, key) {
  const { body } = await call(base, key, "/v1/usage");
  return body;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "expired"]);

/**
 * Poll a job to a terminal state, honouring Retry-After.
 *
 * The API documents separate budgets for submitting and for polling precisely so a CI job can
 * sit on this endpoint, and it documents Retry-After on both queued and running. Ignoring it
 * would earn a 429 and teach a visitor the wrong lesson about how to write the client they are
 * about to go and write.
 */
export async function pollToEnd(base, key, id, onUpdate, signal) {
  for (;;) {
    if (signal && signal.aborted) return null;
    const { body, retryAfter } = await getJob(base, key, id);
    if (onUpdate) onUpdate(body);
    if (body && TERMINAL.has(body.status)) return body;
    const wait = Math.max(retryAfter || (body && body.status === "queued" ? 5 : 2), 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

/** The one-line summary of an error, for the panel. */
export function describeError(e) {
  if (!(e instanceof ApiError)) return { title: "Something went wrong", detail: String(e) };
  const parts = [];
  if (e.detail && e.detail.op_index !== undefined) parts.push(`op ${e.detail.op_index}`);
  if (e.detail && e.detail.limit) parts.push(`limit: ${e.detail.limit}`);
  if (e.detail && e.detail.status) parts.push(`status: ${e.detail.status}`);
  if (e.requestId) parts.push(`request ${e.requestId}`);
  return {
    title: `${e.code}${e.status ? ` (${e.status})` : ""}`,
    detail: e.message,
    meta: parts.join(" · "),
  };
}

export { ApiError };
