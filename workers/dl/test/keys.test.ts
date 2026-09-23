import { describe, expect, it } from "vitest";

import { artifactKey, lifecycleDaysFor, parseArtifactKey, retentionClassFor } from "../src/keys";
import { isValidObjectKey } from "../src/sign";

const ORG = "8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1";
const JOB = "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44";

describe("retention classes", () => {
  it("rounds up, so an object is never swept before the retention that was promised", () => {
    expect(retentionClassFor(1)).toBe("d7");
    expect(retentionClassFor(7)).toBe("d7");
    expect(retentionClassFor(8)).toBe("d30");
    expect(retentionClassFor(30)).toBe("d30");
    expect(retentionClassFor(31)).toBe("d90");
    expect(retentionClassFor(365)).toBe("d365");
  });

  it("treats unlimited and nonsense as the class with no lifecycle rule", () => {
    expect(retentionClassFor(null)).toBe("keep");
    expect(retentionClassFor(undefined)).toBe("keep");
    expect(retentionClassFor(0)).toBe("keep");
    expect(retentionClassFor(-1)).toBe("keep");
    expect(retentionClassFor(366)).toBe("keep");
    expect(retentionClassFor(Number.NaN)).toBe("keep");
  });

  it("gives the bucket one more day than the class, leaving the database sweep to go first", () => {
    expect(lifecycleDaysFor("d7")).toBe(8);
    expect(lifecycleDaysFor("d30")).toBe(31);
    expect(lifecycleDaysFor("d90")).toBe(91);
    expect(lifecycleDaysFor("d365")).toBe(366);
  });
});

describe("artifactKey", () => {
  it("puts the retention class in the prefix, which is the only thing R2 lifecycle can filter on", () => {
    expect(artifactKey({ orgId: ORG, jobId: JOB, kind: "video", retentionDays: 30 })).toBe(
      `a/d30/${ORG}/${JOB}/video.mp4`,
    );
    expect(artifactKey({ orgId: ORG, jobId: JOB, kind: "video", retentionDays: 7 })).toBe(
      `a/d7/${ORG}/${JOB}/video.mp4`,
    );
    expect(artifactKey({ orgId: ORG, jobId: JOB, kind: "video", retentionDays: null })).toBe(
      `a/keep/${ORG}/${JOB}/video.mp4`,
    );
  });

  it("gives every kind its own object under the job, matching the unique constraint on the table", () => {
    expect(artifactKey({ orgId: ORG, jobId: JOB, kind: "poster", retentionDays: 30 })).toContain("/poster.jpg");
    expect(artifactKey({ orgId: ORG, jobId: JOB, kind: "telemetry", retentionDays: 30 })).toContain("/telemetry.json");
    expect(artifactKey({ orgId: ORG, jobId: JOB, kind: "log", retentionDays: 30 })).toContain("/log.txt");
    expect(
      artifactKey({ orgId: ORG, jobId: JOB, kind: "poster", retentionDays: 30, extension: "png" }),
    ).toContain("/poster.png");
  });

  it("produces keys the signer will accept, which is the contract between the two modules", () => {
    expect(isValidObjectKey(artifactKey({ orgId: ORG, jobId: JOB, kind: "video", retentionDays: 30 }))).toBe(true);
  });

  it("refuses anything that is not a uuid, so a key cannot be built out of caller supplied text", () => {
    expect(() => artifactKey({ orgId: "../..", jobId: JOB, kind: "video", retentionDays: 30 })).toThrow();
    expect(() => artifactKey({ orgId: ORG, jobId: "nope", kind: "video", retentionDays: 30 })).toThrow();
    expect(() =>
      artifactKey({ orgId: ORG, jobId: JOB, kind: "video", retentionDays: 30, extension: "mp4/../x" }),
    ).toThrow();
  });
});

describe("parseArtifactKey", () => {
  it("round trips", () => {
    const key = artifactKey({ orgId: ORG, jobId: JOB, kind: "video", retentionDays: 90 });
    expect(parseArtifactKey(key)).toEqual({
      retentionClass: "d90",
      orgId: ORG,
      jobId: JOB,
      kind: "video",
      extension: "mp4",
    });
  });

  it("returns null for a key from another layout rather than throwing at a sweeper", () => {
    expect(parseArtifactKey("orgs/x/take.mp4")).toBeNull();
    expect(parseArtifactKey(`a/d30/${ORG}/${JOB}/unknown.mp4`)).toBeNull();
    expect(parseArtifactKey(`a/d15/${ORG}/${JOB}/video.mp4`)).toBeNull();
  });
});
