import { describe, expect, it } from "vitest";
import { findConflictFiles, isConflictPath, originalPathOf } from "../../src/core/ConflictDetector";

describe("isConflictPath", () => {
  it.each([
    "Note (conflicted copy 2026-10-08).md",
    "Note (Dan's conflicted copy 2026-10-08 101500).md",
    "Note (Conflicted Copy).md",
    "notes/sub/Note (conflicted copy 2026-10-08).md",
    "Note.sync-conflict-20261008-101500-ABCDEFG.md",
    "Note.sync-conflict-20261008-101500.md",
    "Note_conflict-20261008-101500.md",
    "Note (SFConflict dan@example.com 2026-10-08).md",
    "Note (Case Conflict).md",
    "image (conflicted copy 2026-10-08).png",
  ])("flags %s", (path) => {
    expect(isConflictPath(path)).toBe(true);
  });

  it.each([
    "Conflict resolution.md",
    "Notes on conflicts (draft).md",
    "My conflicted feelings.md",
    "Note (1).md",
    "Note 2.md",
    "Note-DESKTOP-ABC1234.md",
    "conflicted copy/Note.md",
    "a.md",
  ])("does not flag %s", (path) => {
    expect(isConflictPath(path)).toBe(false);
  });
});

describe("originalPathOf", () => {
  it("strips the marker and keeps folder and extension", () => {
    expect(originalPathOf("a/b/Note (Dan's conflicted copy 2026-10-08).md")).toBe("a/b/Note.md");
    expect(originalPathOf("Note.sync-conflict-20261008-101500-ABCDEFG.md")).toBe("Note.md");
    expect(originalPathOf("Note_conflict-20261008-101500.md")).toBe("Note.md");
    expect(originalPathOf("Note (SFConflict dan@x 2026-10-08).md")).toBe("Note.md");
    expect(originalPathOf("plain.md")).toBe("plain.md");
  });
});

describe("findConflictFiles", () => {
  it("lists conflict copies sorted, and says whether the original is present", () => {
    const found = findConflictFiles([
      "z/Note.md",
      "z/Note (conflicted copy 1).md",
      "a.md",
      "Lone (conflicted copy 2).md",
      "ok.md",
    ]);
    expect(found).toEqual([
      { path: "Lone (conflicted copy 2).md", original: "Lone.md", originalExists: false },
      { path: "z/Note (conflicted copy 1).md", original: "z/Note.md", originalExists: true },
    ]);
  });

  it("returns nothing for a clean vault", () => {
    expect(findConflictFiles(["a.md", "b/c.md"])).toEqual([]);
  });
});
