import { describe, expect, it } from "vitest";
import type { FileVersion } from "../../src/core/FileVersions";
import { buildVersionRows, describeTimeline } from "../../src/ui/timeMachineModel";

const fmt = (ms: number) => `t${ms}`;
const versions: FileVersion[] = [
  { backupId: "B1", createdAt: 1, kind: "present", size: 10, sha256: "a" },
  { backupId: "B2", createdAt: 2, kind: "present", size: 2048, sha256: "b" },
  { backupId: "B3", createdAt: 3, kind: "deleted" },
];

describe("buildVersionRows", () => {
  it("lists newest first with sizes and deletion points", () => {
    const rows = buildVersionRows(versions, null, fmt);
    expect(rows.map((r) => r.backupId)).toEqual(["B3", "B2", "B1"]);
    expect(rows[0]).toMatchObject({ kind: "deleted", detail: "File deleted at this point" });
    expect(rows[1]).toMatchObject({ title: "t2", detail: "2 KB", isCurrent: false });
  });

  it("marks the version identical to the file now", () => {
    const rows = buildVersionRows(versions, "a", fmt);
    expect(rows.find((r) => r.backupId === "B1")).toMatchObject({
      isCurrent: true,
      detail: "10 B, same as now",
    });
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const copy = [...versions];
    buildVersionRows(versions, null, fmt);
    expect(versions).toEqual(copy);
  });
});

describe("describeTimeline", () => {
  it("counts saved versions, ignoring deletion points", () => {
    expect(describeTimeline("a.md", buildVersionRows(versions, null, fmt))).toBe(
      "a.md: 2 saved versions, newest first.",
    );
    expect(describeTimeline("a.md", buildVersionRows(versions.slice(0, 1), null, fmt))).toContain(
      "1 saved version,",
    );
  });

  it("says so when there is nothing", () => {
    expect(describeTimeline("a.md", [])).toBe("a.md is not in any backup yet.");
  });
});
