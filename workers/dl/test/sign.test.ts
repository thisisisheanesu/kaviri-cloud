import { describe, expect, it } from "vitest";

import { isValidObjectKey, mintSignedPath, mintSignedUrl, verifySignedPath } from "../src/sign";

const SECRET = "a signing secret that only the edge and this worker hold";
const OTHER = "the secret we rotated away from";
const KEY = "a/d30/8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/video.mp4";

const NOW = 1_800_000_000;

describe("minting", () => {
  it("produces a path with the signature in it and nothing in the query", async () => {
    const { path, expiresAt } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });

    expect(path.startsWith("/1/")).toBe(true);
    expect(path).not.toContain("?");
    expect(path.endsWith(`/${KEY}`)).toBe(true);
    expect(expiresAt).toBe(NOW + 300);
  });

  it("clamps the lifetime to the caller's ceiling, which is how a link cannot outlive its artifact", async () => {
    const { expiresAt } = await mintSignedPath({
      key: KEY,
      ttlSeconds: 60 * 60 * 24 * 365,
      maxTtlSeconds: 600,
      secret: SECRET,
      now: NOW,
    });

    expect(expiresAt).toBe(NOW + 600);
  });

  it("refuses a key that could move the field boundary in the signed message", async () => {
    await expect(mintSignedPath({ key: "a/b\nc", ttlSeconds: 60, secret: SECRET })).rejects.toThrow();
    await expect(mintSignedPath({ key: "", ttlSeconds: 60, secret: SECRET })).rejects.toThrow();
    await expect(mintSignedPath({ key: "a/../b", ttlSeconds: 60, secret: SECRET })).rejects.toThrow();
  });

  it("refuses to sign with an empty secret rather than emitting a forgeable link", async () => {
    await expect(mintSignedPath({ key: KEY, ttlSeconds: 60, secret: "" })).rejects.toThrow();
  });

  it("builds an absolute url from configuration, not from a request host", async () => {
    const { url } = await mintSignedUrl("https://dl.kaviri.dev/", { key: KEY, ttlSeconds: 60, secret: SECRET, now: NOW });
    expect(url.startsWith("https://dl.kaviri.dev/1/")).toBe(true);
  });
});

describe("verifying", () => {
  it("accepts what it minted", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });
    const result = await verifySignedPath(path, [SECRET], NOW + 10);

    expect(result).toEqual({ ok: true, key: KEY, expiresAt: NOW + 300 });
  });

  it("round trips a key with characters that have to be percent encoded", async () => {
    const awkward = "a/keep/8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/log file.txt";
    const { path } = await mintSignedPath({ key: awkward, ttlSeconds: 300, secret: SECRET, now: NOW });

    expect(path).toContain("log%20file.txt");
    const result = await verifySignedPath(path, [SECRET], NOW);
    expect(result).toEqual({ ok: true, key: awkward, expiresAt: NOW + 300 });
  });

  it("rejects a changed key, which is the whole point", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });
    const tampered = path.replace("video.mp4", "telemetry.json");

    expect(await verifySignedPath(tampered, [SECRET], NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an extended expiry", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });
    const segments = path.split("/");
    segments[2] = (NOW + 999_999).toString(36);

    expect(await verifySignedPath(segments.join("/"), [SECRET], NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a re-spelled expiry, so every link has exactly one valid form", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });
    const segments = path.split("/");
    segments[2] = `0${segments[2]}`;

    expect(await verifySignedPath(segments.join("/"), [SECRET], NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports an expired link separately, because the customer can fix that one", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });

    expect(await verifySignedPath(path, [SECRET], NOW + 301)).toEqual({ ok: false, reason: "expired" });
  });

  it("checks the signature before the expiry, so an unsigned guess learns nothing", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });

    expect(await verifySignedPath(path, [OTHER], NOW + 301)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("honours links signed with the previous secret during a rotation", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: OTHER, now: NOW });

    expect(await verifySignedPath(path, [SECRET, OTHER], NOW)).toMatchObject({ ok: true, key: KEY });
    expect(await verifySignedPath(path, [SECRET], NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an empty secret list rather than treating it as a match", async () => {
    const { path } = await mintSignedPath({ key: KEY, ttlSeconds: 300, secret: SECRET, now: NOW });

    expect(await verifySignedPath(path, ["", ""], NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects shapes that are not signed paths at all", async () => {
    expect(await verifySignedPath("/", [SECRET], NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifySignedPath("/1/abc/short/key.mp4", [SECRET], NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifySignedPath("/2/abc/" + "x".repeat(43) + "/key.mp4", [SECRET], NOW)).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });
});

describe("key validation", () => {
  it("accepts the layout the render worker writes", () => {
    expect(isValidObjectKey(KEY)).toBe(true);
  });

  it("rejects traversal, empty segments and control characters", () => {
    expect(isValidObjectKey("a/../b")).toBe(false);
    expect(isValidObjectKey("a//b")).toBe(false);
    expect(isValidObjectKey("/a/b")).toBe(false);
    expect(isValidObjectKey("a/b/")).toBe(false);
    expect(isValidObjectKey("a/b\u0000c")).toBe(false);
    expect(isValidObjectKey("x".repeat(1025))).toBe(false);
  });
});
