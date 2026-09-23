import { describe, expect, it } from "vitest";
import { API_KEY_SHAPE } from "../src/auth";
import { orgTokenClaims, readJwtPayload, signJwt } from "../src/jwt";

describe("telling the two callers apart by shape", () => {
  it("recognises a well formed key", () => {
    expect(API_KEY_SHAPE.test("kv_7f3k4x2m_aG9sZFRoaXNJc0Fub3RoZXJSYW5kb21TZWNyZXQ")).toBe(true);
  });

  it("refuses a prefix that is not eight base32 characters", () => {
    expect(API_KEY_SHAPE.test("kv_7f3k9x2_aG9sZFRoaXNJc0Fub3RoZXI")).toBe(false);
    expect(API_KEY_SHAPE.test("kv_7f3k9x28_aG9sZFRoaXNJc0Fub3RoZXI")).toBe(false);
  });

  it("refuses a secret that is too short to be one", () => {
    expect(API_KEY_SHAPE.test("kv_7f3k4x2m_short")).toBe(false);
  });

  it("does not mistake a session JWT for a key", () => {
    expect(API_KEY_SHAPE.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig")).toBe(false);
  });
});

describe("the short-lived org token", () => {
  const now = 1_758_623_000_000;

  it("carries the role and the org, and expires in a minute", () => {
    const claims = orgTokenClaims("org-1", "key-1", now);
    expect(claims.role).toBe("kaviri_api");
    expect(claims.kaviri_org).toBe("org-1");
    expect(claims.kaviri_key).toBe("key-1");
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("carries no sub, because a machine caller must not read as a human", () => {
    // app.current_user_id reads sub, and app.is_org_admin refuses a caller that has an
    // org claim. A sub here would start satisfying predicates written for a person.
    expect("sub" in orgTokenClaims("org-1", "key-1", now)).toBe(false);
  });

  it("signs something a reader can decode and a verifier can check", async () => {
    const token = await signJwt(orgTokenClaims("org-1", "key-1", now) as unknown as Record<string, unknown>, "secret");
    expect(token.split(".")).toHaveLength(3);
    expect(readJwtPayload(token)).toMatchObject({ role: "kaviri_api", kaviri_org: "org-1" });
  });

  it("reads nothing out of a token that is not one", () => {
    expect(readJwtPayload("not.a.jwt")).toBeNull();
    expect(readJwtPayload("two.parts")).toBeNull();
  });
});
