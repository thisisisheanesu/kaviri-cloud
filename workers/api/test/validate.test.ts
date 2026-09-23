import { describe, expect, it } from "vitest";
import { ApiError } from "../src/http";
import {
  decodeCursor,
  encodeCursor,
  isNonRoutableHost,
  validateListQuery,
  validateOptions,
  validateScript,
  validateSubmitBody,
} from "../src/validate";

function thrown(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to throw an ApiError");
}

const NAVIGATE = { op: "navigate", url: "https://kaviri.dev" };

describe("script validation", () => {
  it("accepts the script from the docs", () => {
    expect(() =>
      validateScript([
        NAVIGATE,
        { op: "click", selector: "#get-started" },
        { op: "type", selector: "#email", text: "ada@example.com" },
        { op: "wait", selector: ".welcome", timeout_ms: 20000 },
        { op: "wait", ms: 1500 },
      ]),
    ).not.toThrow();
  });

  it("refuses a wait that takes both ms and selector, and says which op", () => {
    const err = thrown(() => validateScript([NAVIGATE, { op: "wait", ms: 10, selector: ".x" }]));
    expect(err.status).toBe(422);
    expect(err.code).toBe("script_invalid");
    expect(err.detail).toMatchObject({ op_index: 1 });
    expect(err.message).toContain("never both");
  });

  it("refuses a wait with neither", () => {
    expect(thrown(() => validateScript([{ op: "wait" }])).code).toBe("script_invalid");
  });

  it("requires a numeric y on scroll, because a stringified one used to scroll to the top", () => {
    expect(thrown(() => validateScript([{ op: "scroll", y: "600" }])).detail).toMatchObject({ op_index: 0 });
    expect(() => validateScript([{ op: "scroll", y: 600 }])).not.toThrow();
  });

  it("honours a duration written as a float and refuses one that is not a number", () => {
    expect(() => validateScript([{ op: "wait", ms: 62.5 }])).not.toThrow();
    expect(thrown(() => validateScript([{ op: "wait", ms: -1 }])).code).toBe("script_invalid");
    expect(thrown(() => validateScript([{ op: "navigate", url: "https://a.dev", timeout_ms: "5000" }])).code).toBe(
      "script_invalid",
    );
  });

  it("rejects an unknown op", () => {
    expect(thrown(() => validateScript([{ op: "screenshot" }])).message).toContain("unknown op");
  });

  it("rejects an empty script and a script that is not an array", () => {
    expect(thrown(() => validateScript([])).message).toContain("empty");
    expect(thrown(() => validateScript({ op: "wait", ms: 1 })).message).toContain("array");
  });

  it("accepts start_recording and stop_recording, which the service supplies anyway", () => {
    expect(() => validateScript([{ op: "start_recording" }, NAVIGATE, { op: "stop_recording" }])).not.toThrow();
  });

  it("needs a selector or a point for a click", () => {
    expect(thrown(() => validateScript([{ op: "click" }])).code).toBe("script_invalid");
    expect(() => validateScript([{ op: "click", x: 10, y: 20 }])).not.toThrow();
  });
});

describe("what a shared fleet will open", () => {
  it("refuses a local file, which the self hosted recorder is happy to film", () => {
    const err = thrown(() => validateScript([{ op: "navigate", url: "file:///etc/passwd" }]));
    expect(err.code).toBe("script_invalid");
    expect(err.detail).toMatchObject({ protocol: "file:" });
  });

  it("refuses the cloud metadata address and the private ranges around it", () => {
    for (const host of ["169.254.169.254", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "100.100.0.1", "localhost", "::1", "fd00::1", "[::ffff:169.254.169.254]"]) {
      expect(isNonRoutableHost(host), host).toBe(true);
    }
  });

  it("allows an ordinary public host", () => {
    for (const host of ["kaviri.dev", "8.8.8.8", "172.32.0.1", "192.167.0.1", "2606:4700::1"]) {
      expect(isNonRoutableHost(host), host).toBe(false);
    }
  });

  it("refuses a relative url", () => {
    expect(thrown(() => validateScript([{ op: "navigate", url: "/index.html" }])).code).toBe("script_invalid");
  });
});

describe("options", () => {
  it("rejects an unknown field, so a typo fails loudly in CI", () => {
    const err = thrown(() => validateOptions({ presset: "desktop" }));
    expect(err.code).toBe("unknown_field");
    expect(err.detail).toMatchObject({ field: "presset" });
  });

  it("rejects an unknown preset and an out of range scale", () => {
    expect(thrown(() => validateOptions({ preset: "imax" })).code).toBe("options_invalid");
    expect(thrown(() => validateOptions({ scale: 9 })).code).toBe("options_invalid");
    expect(thrown(() => validateOptions({ cursor_scale: 0.1 })).code).toBe("options_invalid");
  });

  it("keeps a null out_width, because null means take the preset size", () => {
    expect(validateOptions({ out_width: null, out_height: 1920 })).toEqual({ out_width: null, out_height: 1920 });
  });

  it("refuses a fractional pixel size", () => {
    expect(thrown(() => validateOptions({ out_width: 1080.5 })).code).toBe("options_invalid");
  });
});

describe("the submit body", () => {
  const good = { project: "web", script: [NAVIGATE] };

  it("accepts the minimum", () => {
    const body = validateSubmitBody(good, 4096);
    expect(body.project).toBe("web");
    expect(body.idempotency_key).toBeNull();
  });

  it("rejects an unknown top level field", () => {
    expect(thrown(() => validateSubmitBody({ ...good, preset: "desktop" }, 4096)).code).toBe("unknown_field");
  });

  it("rejects a project slug that is not one", () => {
    expect(thrown(() => validateSubmitBody({ ...good, project: "Web Site" }, 4096)).status).toBe(422);
  });

  it("bounds the idempotency key", () => {
    expect(thrown(() => validateSubmitBody({ ...good, idempotency_key: "short" }, 4096)).code).toBe("options_invalid");
    expect(validateSubmitBody({ ...good, idempotency_key: "gha-11224455-1" }, 4096).idempotency_key).toBe(
      "gha-11224455-1",
    );
  });

  it("refuses a source larger than the limit", () => {
    const err = thrown(() => validateSubmitBody({ ...good, source: { pad: "x".repeat(5000) } }, 4096));
    expect(err.status).toBe(413);
    expect(err.code).toBe("request_too_large");
  });
});

describe("list query and cursor", () => {
  it("bounds the limit", () => {
    expect(validateListQuery(new URLSearchParams("limit=100")).limit).toBe(100);
    expect(thrown(() => validateListQuery(new URLSearchParams("limit=101"))).code).toBe("options_invalid");
    expect(thrown(() => validateListQuery(new URLSearchParams("limit=0"))).code).toBe("options_invalid");
  });

  it("takes a repeated status", () => {
    expect(validateListQuery(new URLSearchParams("status=queued&status=done")).statuses).toEqual(["queued", "done"]);
  });

  it("rejects a database state that is not an API status", () => {
    expect(thrown(() => validateListQuery(new URLSearchParams("status=leased"))).code).toBe("options_invalid");
  });

  it("round trips a cursor and refuses a forged one", () => {
    const cursor = encodeCursor("2026-09-23T11:04:02.481Z", "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44");
    expect(decodeCursor(cursor)).toEqual({
      created_at: "2026-09-23T11:04:02.481Z",
      id: "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
    });
    expect(thrown(() => decodeCursor("not-a-cursor")).code).toBe("options_invalid");
  });
});
