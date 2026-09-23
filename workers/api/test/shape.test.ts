import { describe, expect, it } from "vitest";
import { apiStatus, retryAfterFor, shapeArtifacts, shapeError, shapeJob, type JobRow } from "../src/shape";

const base: JobRow = {
  id: "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
  state: "queued",
  progress: 0,
  progress_message: null,
  attempt: 0,
  max_attempts: 3,
  created_at: "2026-09-23T11:04:02.481Z",
  started_at: null,
  finished_at: null,
  expires_at: null,
  render_seconds: 0,
  error: null,
  projects: { slug: "web" },
  artifacts: [],
};

describe("eight database states, six API states", () => {
  it("reports leased and uploading as running", () => {
    expect(apiStatus("leased")).toBe("running");
    expect(apiStatus("uploading")).toBe("running");
    expect(apiStatus("running")).toBe("running");
  });

  it("passes the other five through unchanged", () => {
    for (const s of ["queued", "done", "failed", "cancelled", "expired"]) {
      expect(apiStatus(s)).toBe(s);
    }
  });

  it("throws rather than inventing a status for a state it does not know", () => {
    expect(() => apiStatus("melting")).toThrow();
  });

  it("asks a queued client back in five seconds and a running one in two", () => {
    expect(retryAfterFor("queued")).toBe(5);
    expect(retryAfterFor("running")).toBe(2);
    expect(retryAfterFor("done")).toBeNull();
  });
});

describe("the job body", () => {
  it("carries the project slug and both links", () => {
    const body = shapeJob(base);
    expect(body["project"]).toBe("web");
    expect(body["links"]).toEqual({
      self: "/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
      artifact: "/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/artifact",
    });
  });

  it("omits message when there is none and includes it when there is", () => {
    expect(shapeJob(base)["message"]).toBeUndefined();
    expect(shapeJob({ ...base, state: "running", progress_message: "op 12 of 31: click #buy" })["message"]).toBe(
      "op 12 of 31: click #buy",
    );
  });

  it("renders a bytea digest as hex without the Postgres prefix", () => {
    expect(shapeJob({ ...base, script_sha256: "\\x6b1fc0" })["script_sha256"]).toBe("6b1fc0");
  });

  it("copes with a numeric that arrives as a string", () => {
    expect(shapeJob({ ...base, state: "done", finished_at: base.created_at, render_seconds: "92.400" })["render_seconds"]).toBe(
      92.4,
    );
  });

  it("takes the slug from an embedded array, which is how PostgREST may return it", () => {
    expect(shapeJob({ ...base, projects: [{ slug: "docs" }] })["project"]).toBe("docs");
  });
});

describe("artifacts", () => {
  const video = {
    kind: "video",
    content_type: "video/mp4",
    bytes: 8123456,
    sha256: "\\x3f9a11",
    duration_seconds: "21.400",
    width: 1470,
    height: 830,
    deleted_at: null,
  };

  it("hides a swept artifact, because a customer cannot download it", () => {
    expect(shapeArtifacts("j", "expired", [{ ...video, deleted_at: "2026-10-23T11:05:41.902Z" }])).toEqual([]);
  });

  it("flags footage from a failed take as partial rather than hiding it", () => {
    const [first] = shapeArtifacts("j", "failed", [video]);
    expect(first!["partial"]).toBe(true);
    expect(shapeArtifacts("j", "done", [video])[0]!["partial"]).toBeUndefined();
  });

  it("points at the download endpoint with the kind it is", () => {
    expect(shapeArtifacts("j", "done", [video])[0]!["url"]).toBe("/v1/jobs/j/artifact?kind=video");
  });
});

describe("the error on a failed job", () => {
  it("nests what the worker wrote flat, and keeps the stable code", () => {
    const shaped = shapeError({
      code: "op_failed",
      message: "selector matched a non-visible element: #done",
      retryable: false,
      op_index: 7,
      op: { op: "click", selector: "#done" },
    });
    expect(shaped).toEqual({
      code: "op_failed",
      message: "selector matched a non-visible element: #done",
      retryable: false,
      detail: { op_index: 7, op: { op: "click", selector: "#done" } },
    });
  });

  it("defaults retryable to true, because most of what goes wrong on a box is transient", () => {
    expect(shapeError({ code: "browser_launch_failed", message: "chromium would not start" })!["retryable"]).toBe(true);
  });

  it("is null when the job has not failed", () => {
    expect(shapeError(null)).toBeNull();
  });
});
