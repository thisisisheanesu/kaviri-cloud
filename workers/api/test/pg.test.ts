import { describe, expect, it } from "vitest";
import { limitFromMessage, pgErrorToApiError } from "../src/pg";

describe("which limit a 54000 was about", () => {
  it("recovers the stable name from the wording submit_job raises", () => {
    expect(limitFromMessage("script has 2400 ops, the limit is 2000")).toBe("max_script_ops");
    expect(limitFromMessage("monthly job limit of 500 reached")).toBe("max_jobs_per_month");
    expect(limitFromMessage("monthly render seconds limit of 36000 reached")).toBe("max_render_seconds_per_month");
    expect(limitFromMessage("storage limit of 1000 bytes reached")).toBe("max_stored_bytes");
  });

  it("says nothing rather than guessing at wording it does not know", () => {
    expect(limitFromMessage("something else entirely")).toBeUndefined();
  });
});

describe("Postgres errcode to HTTP", () => {
  it("answers no such row as 404, so an id cannot be probed across tenants", () => {
    const err = pgErrorToApiError({ code: "P0002", message: "no such job" }, 404);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  it("answers a limit as 402 and names it, never a cost", () => {
    const err = pgErrorToApiError({ code: "54000", message: "script has 2400 ops, the limit is 2000" }, 400);
    expect(err.status).toBe(402);
    expect(err.code).toBe("limit_exceeded");
    expect(err.detail).toEqual({ limit: "max_script_ops" });
  });

  it("answers insufficient privilege as 404 for the same reason as P0002", () => {
    expect(pgErrorToApiError({ code: "42501", message: "not an admin" }, 403).status).toBe(404);
  });

  it("answers a malformed argument as 422", () => {
    expect(pgErrorToApiError({ code: "22023", message: "script is empty" }, 400).code).toBe("script_invalid");
  });

  it("does not leak an unmapped database message to the caller", () => {
    const err = pgErrorToApiError({ code: "42P01", message: 'relation "secret" does not exist' }, 400);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("secret");
  });

  it("turns an upstream outage into a 503 with a Retry-After", () => {
    const err = pgErrorToApiError(null, 503);
    expect(err.status).toBe(503);
    expect(err.headers).toMatchObject({ "retry-after": "5" });
  });
});
