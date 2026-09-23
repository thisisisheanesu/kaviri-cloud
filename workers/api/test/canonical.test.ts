import { describe, expect, it } from "vitest";
import { byteaToHex, canonicalJson, sha256Hex, submissionFingerprint } from "../src/canonical";

describe("canonical JSON", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("leaves array order alone, because a script is an order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles the scalars", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("a")).toBe('"a"');
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("the submission fingerprint", () => {
  const script = [{ op: "navigate", url: "https://kaviri.dev" }];

  it("is the same after a round trip that reordered the keys", async () => {
    const a = await submissionFingerprint([{ op: "wait", ms: 10, selector: undefined }], { preset: "tiktok", scale: 2 });
    const b = await submissionFingerprint([{ ms: 10, op: "wait" }], { scale: 2, preset: "tiktok" });
    expect(a).toBe(b);
  });

  it("changes when the script changes", async () => {
    const a = await submissionFingerprint(script, {});
    const b = await submissionFingerprint([...script, { op: "wait", ms: 1 }], {});
    expect(a).not.toBe(b);
  });

  it("changes when the options change", async () => {
    expect(await submissionFingerprint(script, { preset: "desktop" })).not.toBe(
      await submissionFingerprint(script, { preset: "tiktok" }),
    );
  });

  it("is a sha256 hex digest", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("bytea", () => {
  it("strips the Postgres hex prefix and tolerates one that is already plain", () => {
    expect(byteaToHex("\\xdeadbeef")).toBe("deadbeef");
    expect(byteaToHex("deadbeef")).toBe("deadbeef");
    expect(byteaToHex(null)).toBeNull();
  });
});
