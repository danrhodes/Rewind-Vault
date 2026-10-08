import { describe, expect, it } from "vitest";
import type { DeletedFile } from "../../src/core/RestoreEngine";
import { describeDeleted, filterDeleted, groupByBackup } from "../../src/ui/recoverModel";

const files: DeletedFile[] = [
  { path: "Notes/Alpha.md", deletedAt: 3, lastBackupId: "B2" },
  { path: "Notes/beta.md", deletedAt: 2, lastBackupId: "B1" },
  { path: "img/Alpha.png", deletedAt: 1, lastBackupId: "B2" },
];

describe("filterDeleted", () => {
  it("matches case-insensitively anywhere in the path", () => {
    expect(filterDeleted(files, "alpha").map((f) => f.path)).toEqual([
      "Notes/Alpha.md",
      "img/Alpha.png",
    ]);
    expect(filterDeleted(files, "  NOTES/b ").map((f) => f.path)).toEqual(["Notes/beta.md"]);
  });
  it("keeps everything for an empty query and does not alias the input", () => {
    const all = filterDeleted(files, " ");
    expect(all).toEqual(files);
    expect(all).not.toBe(files);
  });
});

describe("groupByBackup", () => {
  it("groups chosen paths by the backup holding them, ignoring unknown paths", () => {
    const chosen = new Set(["img/Alpha.png", "Notes/Alpha.md", "Notes/beta.md", "nope.md"]);
    expect(groupByBackup(files, chosen)).toEqual([
      { backupId: "B2", paths: ["Notes/Alpha.md", "img/Alpha.png"] },
      { backupId: "B1", paths: ["Notes/beta.md"] },
    ]);
  });
  it("is empty when nothing is chosen", () => {
    expect(groupByBackup(files, new Set())).toEqual([]);
  });
});

describe("describeDeleted", () => {
  it("covers empty, filtered and plain lists", () => {
    expect(describeDeleted(0, 0, 0)).toContain("No deleted files");
    expect(describeDeleted(3, 3, 1)).toBe("3 deleted file(s), 1 selected.");
    expect(describeDeleted(1, 3, 0)).toBe("1 of 3 deleted file(s), 0 selected.");
  });
});
