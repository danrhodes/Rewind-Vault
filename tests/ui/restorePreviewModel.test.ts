import { describe, expect, it } from "vitest";
import type { PreviewItem, RestorePreview } from "../../src/core/RestoreTypes";
import {
  RestoreSelection,
  chooseRestore,
  summarizeRestore,
} from "../../src/ui/restorePreviewModel";
import { entry } from "../support/retentionFixtures";

const item = (path: string, size = 100, currentSize?: number): PreviewItem => ({
  path,
  size,
  backupId: "b1",
  ...(currentSize !== undefined ? { currentSize } : {}),
});

function preview(extra: Partial<RestorePreview> = {}): RestorePreview {
  const additions = [item("new/a.md", 100), item("new/b.md", 200)];
  const changes = [item("old/c.md", 300, 250), item("old/d.md", 400, 400)];
  return {
    source: entry({ id: "b1", age: 0 }),
    destinationRoot: "restore/b1",
    additions,
    changes,
    deletions: [],
    unchanged: 7,
    bytesToWrite: 1000,
    ...extra,
  };
}

describe("RestoreSelection defaults", () => {
  it("restore folder: everything starts ticked", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    expect(s.total).toBe(4);
    expect(s.selectedCount).toBe(4);
    expect(s.isEverything).toBe(true);
    expect(s.selectedBytes).toBe(1000);
  });

  it("live vault: new files ticked, replacements NOT ticked until the user ticks them", () => {
    const s = new RestoreSelection(preview(), { changesSelected: false });
    expect(s.selectedPaths).toEqual(["new/a.md", "new/b.md"]);
    expect(s.selectedReplacements).toBe(0);
    expect(s.isEverything).toBe(false);
    expect(s.groupState("additions")).toBe("all");
    expect(s.groupState("changes")).toBe("none");
  });

  it("lists rows per group with their sizes, current size for replacements", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    expect(s.rows("additions").map((r) => r.path)).toEqual(["new/a.md", "new/b.md"]);
    expect(s.rows("changes")[0]).toMatchObject({ path: "old/c.md", size: 300, currentSize: 250 });
    expect("currentSize" in s.rows("additions")[0]!).toBe(false);
  });

  it("an empty preview has nothing to select", () => {
    const s = new RestoreSelection(preview({ additions: [], changes: [], bytesToWrite: 0 }), {
      changesSelected: true,
    });
    expect(s.total).toBe(0);
    expect(s.isEverything).toBe(false);
    expect(chooseRestore(s)).toBeNull();
  });
});

describe("RestoreSelection editing", () => {
  it("toggles single files, ignoring paths that are not in the preview", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    s.toggle("new/a.md");
    expect(s.isSelected("new/a.md")).toBe(false);
    expect(s.selectedCount).toBe(3);
    s.toggle("new/a.md");
    expect(s.isSelected("new/a.md")).toBe(true);
    s.toggle("nope.md");
    expect(s.selectedCount).toBe(4);
    expect(s.isSelected("nope.md")).toBe(false);
  });

  it("group state is none / some / all", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    expect(s.groupState("changes")).toBe("all");
    s.toggle("old/c.md");
    expect(s.groupState("changes")).toBe("some");
    s.toggle("old/d.md");
    expect(s.groupState("changes")).toBe("none");
  });

  it("setGroup, selectAll and selectNone", () => {
    const s = new RestoreSelection(preview(), { changesSelected: false });
    s.setGroup("changes", true);
    expect(s.isEverything).toBe(true);
    s.setGroup("additions", false);
    expect(s.selectedPaths).toEqual(["old/c.md", "old/d.md"]);
    s.selectNone();
    expect(s.selectedCount).toBe(0);
    s.selectAll();
    expect(s.selectedCount).toBe(4);
  });

  it("counts selected bytes and replacements", () => {
    const s = new RestoreSelection(preview(), { changesSelected: false });
    s.toggle("old/c.md");
    expect(s.selectedBytes).toBe(100 + 200 + 300);
    expect(s.selectedReplacements).toBe(1);
  });

  it("selectedPaths is sorted and stable", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    expect(s.selectedPaths).toEqual([...s.selectedPaths].sort());
  });
});

describe("chooseRestore", () => {
  it("nothing ticked: no request", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    s.selectNone();
    expect(chooseRestore(s)).toBeNull();
  });

  it("everything ticked: a whole-vault request, overwrite because replacements are ticked", () => {
    const s = new RestoreSelection(preview(), { changesSelected: true });
    expect(chooseRestore(s)).toEqual({ kind: "vault", overwrite: true });
  });

  it("everything ticked with no replacements: no overwrite needed", () => {
    const s = new RestoreSelection(preview({ changes: [] }), { changesSelected: true });
    expect(chooseRestore(s)).toEqual({ kind: "vault", overwrite: false });
  });

  it("a subset: an explicit file list, overwrite only if a replacement is in it", () => {
    const s = new RestoreSelection(preview(), { changesSelected: false });
    expect(chooseRestore(s)).toEqual({
      kind: "files",
      paths: ["new/a.md", "new/b.md"],
      overwrite: false,
    });
    s.toggle("old/d.md");
    expect(chooseRestore(s)).toEqual({
      kind: "files",
      paths: ["new/a.md", "new/b.md", "old/d.md"],
      overwrite: true,
    });
  });
});

describe("summarizeRestore", () => {
  const sel = (changes: boolean) => new RestoreSelection(preview(), { changesSelected: changes });

  it("restore folder: says where, and that notes are untouched", () => {
    const s = summarizeRestore(preview(), sel(true), { kind: "restore-folder" }, true);
    expect(s.touchesVault).toBe(false);
    expect(s.lines[0]).toBe(
      "Restore 4 files (1000 B) into restore/b1/. Your notes are not touched.",
    );
    expect(s.lines).toHaveLength(1);
  });

  it("vault: says what is replaced and that a snapshot is taken", () => {
    const s = summarizeRestore(preview(), sel(true), { kind: "vault" }, true);
    expect(s.touchesVault).toBe(true);
    expect(s.lines.join(" ")).toContain("into your vault");
    expect(s.lines.join(" ")).toContain("2 existing files will be replaced");
    expect(s.lines.join(" ")).toContain("safety snapshot");
  });

  it("vault with the snapshot setting off warns it cannot be undone", () => {
    const s = summarizeRestore(preview(), sel(true), { kind: "vault" }, false);
    expect(s.lines.join(" ")).toContain("cannot be undone");
  });

  it("singular wording and no replacement line when none are ticked", () => {
    const one = new RestoreSelection(preview({ additions: [item("a.md")], changes: [] }), {
      changesSelected: true,
    });
    const s = summarizeRestore(preview(), one, { kind: "vault" }, true);
    expect(s.lines[0]).toContain("1 file (");
    expect(s.lines.join(" ")).not.toContain("replaced");
  });
});
