import { describe, expect, it } from "vitest";

import { contentRange, parseRange, toR2Range, unsatisfiableContentRange } from "../src/range";

const SIZE = 1000;

describe("parseRange", () => {
  it("serves the whole object when there is no Range header", () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: "full" });
    expect(parseRange("", SIZE)).toEqual({ kind: "full" });
  });

  it("handles the two byte probe Safari opens a video with", () => {
    expect(parseRange("bytes=0-1", SIZE)).toEqual({ kind: "partial", start: 0, end: 1 });
  });

  it("handles an open ended range", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("handles a suffix range", () => {
    expect(parseRange("bytes=-200", SIZE)).toEqual({ kind: "partial", start: 800, end: 999 });
  });

  it("clamps a suffix longer than the object rather than refusing it", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("clamps an end past the object, which is what a player asking for bytes=0-99999999 means", () => {
    expect(parseRange("bytes=0-99999999", SIZE)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("calls a start past the end of the object unsatisfiable", () => {
    expect(parseRange("bytes=1000-1100", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("calls a backwards range and a zero length suffix unsatisfiable", () => {
    expect(parseRange("bytes=500-400", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("cannot satisfy any range against an empty object", () => {
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("falls back to the whole object for multiple ranges and for units it does not speak", () => {
    expect(parseRange("bytes=0-1,5-6", SIZE)).toEqual({ kind: "full" });
    expect(parseRange("items=0-1", SIZE)).toEqual({ kind: "full" });
    expect(parseRange("bytes=abc", SIZE)).toEqual({ kind: "full" });
    expect(parseRange("bytes=-", SIZE)).toEqual({ kind: "full" });
  });

  it("is case insensitive about the unit and tolerant of whitespace", () => {
    expect(parseRange(" BYTES=0-1 ", SIZE)).toEqual({ kind: "partial", start: 0, end: 1 });
  });
});

describe("header construction", () => {
  it("writes an inclusive Content-Range", () => {
    expect(contentRange(0, 1, SIZE)).toBe("bytes 0-1/1000");
  });

  it("tells a 416 client how big the object actually is", () => {
    expect(unsatisfiableContentRange(SIZE)).toBe("bytes */1000");
  });

  it("converts an inclusive range to R2's offset and length without an off by one", () => {
    expect(toR2Range(0, 1)).toEqual({ offset: 0, length: 2 });
    expect(toR2Range(500, 999)).toEqual({ offset: 500, length: 500 });
  });
});
