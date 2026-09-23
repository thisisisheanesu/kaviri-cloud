import { describe, expect, it } from "vitest";
import { ApiError, errorBody, errorResponse, jsonResponse, ulid } from "../src/http";

describe("the error body", () => {
  it("has the shape docs/API.md promises", () => {
    const body = errorBody("script_invalid", "op 4: wait takes ms or selector, never both", "01JB5Q", {
      op_index: 4,
    }) as { error: Record<string, unknown> };
    expect(Object.keys(body.error)).toEqual(["code", "message", "detail", "request_id", "docs"]);
    expect(body.error["request_id"]).toBe("01JB5Q");
  });

  it("omits detail rather than setting it to null", () => {
    const body = errorBody("unauthorized", "no credential", "01JB5Q") as { error: Record<string, unknown> };
    expect("detail" in body.error).toBe(false);
  });
});

describe("every response is JSON", () => {
  it("answers an ApiError as JSON with its status, code and headers", async () => {
    const response = errorResponse(
      new ApiError(429, "rate_limited", "too many submit requests for this org", { bucket: "submit" }, {
        "Retry-After": "4",
      }),
      "01JB5Q",
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("Retry-After")).toBe("4");
    expect(response.headers.get("X-Kaviri-Request-Id")).toBe("01JB5Q");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("answers an unexpected throw as JSON and says nothing about it", async () => {
    const response = errorResponse(new TypeError("cannot read property of undefined at line 42"), "01JB5Q");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text.startsWith("{")).toBe(true);
    expect(text).not.toContain("line 42");
    expect(text).toContain("internal");
  });

  it("never sniffs and never caches", () => {
    const response = jsonResponse(200, { ok: true }, "01JB5Q");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the request id", () => {
  it("is 26 Crockford characters and sorts by time", () => {
    const early = ulid(1_758_623_000_000, () => 0);
    const late = ulid(1_758_623_001_000, () => 0);
    expect(early).toHaveLength(26);
    expect(early < late).toBe(true);
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(early)).toBe(true);
  });
});
