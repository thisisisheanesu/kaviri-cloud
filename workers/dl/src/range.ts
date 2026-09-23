// Range requests.
//
// This exists because Safari will not play a video without it. Safari's first request for
// a media element is `Range: bytes=0-1`, and a server that answers it with 200 and the
// whole file is treated as not seekable: the element loads and then refuses to play. So
// byte ranges are not an optimisation here, they are the difference between the demo
// video working on iOS and not.
//
// Everything in this module is a pure function over a header string and a size, which is
// what makes the awkward cases testable without a bucket.

export type RangeRequest =
  /** No Range header, or one this server chooses not to honour. Serve 200 and the lot. */
  | { kind: "full" }
  /** A single satisfiable range. `end` is inclusive, as it is on the wire. */
  | { kind: "partial"; start: number; end: number }
  /** Syntactically fine but outside the object. Answered with 416 and the object size. */
  | { kind: "unsatisfiable" };

/**
 * Parses a Range header against a known object size.
 *
 * Multiple ranges in one request are answered with the whole object rather than a
 * multipart/byteranges body. RFC 9110 permits that, no media element asks for one, and
 * the alternative is assembling MIME boundaries by hand in a Worker for a case that never
 * arrives.
 */
export function parseRange(header: string | null | undefined, size: number): RangeRequest {
  if (!header) return { kind: "full" };

  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match) return { kind: "full" };

  const captured = match[1];
  if (captured === undefined) return { kind: "full" };
  const specs = captured.split(",");
  // A single range only. See above.
  if (specs.length !== 1) return { kind: "full" };

  const spec = (specs[0] ?? "").trim();
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: "full" };

  const rawStart = parts[1] ?? "";
  const rawEnd = parts[2] ?? "";
  if (rawStart === "" && rawEnd === "") return { kind: "full" };

  // A zero byte object cannot satisfy any range at all, including a suffix range.
  if (size === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    // Suffix form, `bytes=-500`: the last 500 bytes. `bytes=-0` asks for nothing, which
    // is unsatisfiable rather than an empty 206.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - suffix);
    return { kind: "partial", start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };

  if (rawEnd === "") {
    // Open ended, `bytes=1024-`: everything from there on.
    return { kind: "partial", start, end: size - 1 };
  }

  const requestedEnd = Number(rawEnd);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return { kind: "unsatisfiable" };

  // An end past the object is clamped rather than refused, which is what every client
  // that asks for `bytes=0-99999999` on a short file expects.
  return { kind: "partial", start, end: Math.min(requestedEnd, size - 1) };
}

/** The Content-Range header for a satisfied range. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** The Content-Range header for a 416, which names the size so the client can retry correctly. */
export function unsatisfiableContentRange(size: number): string {
  return `bytes */${size}`;
}

/**
 * Translates a satisfied range into the shape R2's get() wants. R2 takes an offset and a
 * length, not an inclusive end, and getting that off by one truncates every video by a
 * byte in a way that plays fine locally and fails on one decoder in the wild.
 */
export function toR2Range(start: number, end: number): { offset: number; length: number } {
  return { offset: start, length: end - start + 1 };
}
