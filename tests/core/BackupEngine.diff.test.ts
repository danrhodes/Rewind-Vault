import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadState } from "../../src/core/BackupState";
import { enc, rig, seedVault, type Rig, runOk } from "../support/engineRig";
import { idsOf, reconstruct } from "../support/chain";
import { readBackupFolder } from "../support/readBackup";

const SECOND = 1000;

/** Snapshot of the live vault, to compare against a reconstructed backup chain. */
async function snapshot(r: Rig): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const walk = async (folder: string): Promise<void> => {
    const l = await r.store.list(folder);
    for (const f of l.files) if (!f.startsWith("backup/")) out.set(f, await r.store.readBinary(f));
    for (const d of l.folders) if (d !== "backup") await walk(d);
  };
  await walk("");
  return out;
}

async function expectChainEqualsVault(r: Rig): Promise<void> {
  const index = await loadIndex(r.store, "backup");
  expect(await reconstruct(r.store, "backup", idsOf(index))).toEqual(await snapshot(r));
}

async function touch(r: Rig, path: string, text: string): Promise<void> {
  r.clock.advance(SECOND);
  await r.store.writeBinary(path, enc(text));
}

describe("BackupEngine differential mode", () => {
  it("stores only added and changed files, tombstones deletions, and links to the base", async () => {
    const r = rig();
    await seedVault(r.store, 30);
    const full = await runOk(r.engine, { mode: "full" });

    await touch(r, "folder0/sub0/note-0.md", "edited!");
    await touch(r, "brand-new.md", "hello");
    r.clock.advance(SECOND);
    await r.store.remove("folder1/sub1/note-1.md");

    const diff = await runOk(r.engine, { mode: "diff" });
    expect(diff).toMatchObject({ type: "diff", fileCount: 2 });
    expect(diff.forcedFullReason).toBeUndefined();

    const { manifest } = await readBackupFolder(r.store, `backup/${diff.backupId}`);
    expect(manifest.baseId).toBe(full.backupId);
    expect(manifest.entries.map((e) => [e.path, e.action]).sort()).toEqual([
      ["brand-new.md", "add"],
      ["folder0/sub0/note-0.md", "change"],
    ]);
    expect(manifest.tombstones.map((t) => t.path)).toEqual(["folder1/sub1/note-1.md"]);
    expect(manifest.tombstones[0]!.deletedAt).toBeGreaterThan(0);
  });

  it("chain test: full + several diffs always reconstruct the live vault", async () => {
    const r = rig();
    await seedVault(r.store, 40);
    await runOk(r.engine, { mode: "full" });
    await expectChainEqualsVault(r);

    // Round 1: edits, additions, a delete.
    await touch(r, "folder2/sub2/note-2.md", "round one edit");
    await touch(r, "new/one.md", "1");
    r.clock.advance(SECOND);
    await r.store.remove("folder3/sub0/note-3.md");
    await runOk(r.engine, { mode: "diff" });
    await expectChainEqualsVault(r);

    // Round 2: edit the same file again, delete the file added in round 1, add a rename.
    await touch(r, "folder2/sub2/note-2.md", "round two edit");
    r.clock.advance(SECOND);
    await r.store.remove("new/one.md");
    await r.store.rename("folder4/sub1/note-4.md", "renamed/note-4.md");
    await runOk(r.engine, { mode: "diff" });
    await expectChainEqualsVault(r);

    // Round 3: re-create a deleted path with new content.
    await touch(r, "folder3/sub0/note-3.md", "back from the dead");
    await runOk(r.engine, { mode: "diff" });
    await expectChainEqualsVault(r);

    const index = await loadIndex(r.store, "backup");
    expect(index.backups.map((b) => b.type)).toEqual(["full", "diff", "diff", "diff"]);
    expect(new Set(index.backups.filter((b) => b.type === "diff").map((b) => b.baseId)).size).toBe(
      1,
    );
  });

  it("each diff is relative to the previous backup, not to the base", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    await r.store.seed("b.md", "1");
    await runOk(r.engine, { mode: "full" });
    await touch(r, "a.md", "22");
    await runOk(r.engine, { mode: "diff" });
    await touch(r, "b.md", "22");
    const third = await runOk(r.engine, { mode: "diff" });
    const { manifest } = await readBackupFolder(r.store, `backup/${third.backupId}`);
    expect(manifest.entries.map((e) => e.path)).toEqual(["b.md"]);
  });

  it("a timestamp-only change creates no entry but is remembered in state", async () => {
    const r = rig((p) => void (p.conditions.skipIfNoChanges = false));
    await r.store.seed("a.md", "same");
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(5 * SECOND);
    await r.store.writeBinary("a.md", enc("same")); // new mtime, identical bytes
    const diff = await runOk(r.engine, { mode: "diff" });
    expect(diff.fileCount).toBe(0);
    const state = await loadState(r.store, "backup");
    expect(state.files["a.md"]!.mtime).toBe(r.clock.now());
  });

  it("deleted files leave the state so they are not tombstoned twice", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    await r.store.seed("b.md", "1");
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(SECOND);
    await r.store.remove("a.md");
    await runOk(r.engine, { mode: "diff" });
    expect(Object.keys((await loadState(r.store, "backup")).files)).toEqual(["b.md"]);
    await touch(r, "b.md", "2");
    const third = await runOk(r.engine, { mode: "diff" });
    const { manifest } = await readBackupFolder(r.store, `backup/${third.backupId}`);
    expect(manifest.tombstones).toEqual([]);
  });
});

describe("differential requests that must become full backups", () => {
  it("no previous backup at all", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    const result = await runOk(r.engine, { mode: "diff" });
    expect(result.type).toBe("full");
    expect(result.forcedFullReason).toContain("no previous backup state");
    expect(r.logger.messages("warn").join()).toContain("became a full backup");
  });

  it("damaged state.json: warns, makes a full backup, and repairs the state", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    await runOk(r.engine, { mode: "full" });
    await r.store.seed("backup/state.json", "{ garbage");
    r.clock.advance(SECOND);
    const result = await runOk(r.engine, { mode: "diff" });
    expect(result.type).toBe("full");
    expect(result.forcedFullReason).toContain("unreadable");
    expect(Object.keys((await loadState(r.store, "backup")).files)).toEqual(["a.md"]);
  });

  it("no intact full backup in the index", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    const full = await runOk(r.engine, { mode: "full" });
    const index = await loadIndex(r.store, "backup");
    const { saveIndex } = await import("../../src/core/BackupIndex");
    await saveIndex(r.store, "backup", {
      ...index,
      backups: index.backups.map((b) => ({
        ...b,
        status: b.id === full.backupId ? "corrupt" : b.status,
      })),
    });
    r.clock.advance(SECOND);
    const result = await runOk(r.engine, { mode: "diff" });
    expect(result.type).toBe("full");
    expect(result.forcedFullReason).toContain("no intact full backup");
  });

  it("a new full backup becomes the base for later diffs", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    await runOk(r.engine, { mode: "full" });
    await touch(r, "a.md", "2");
    const second = await runOk(r.engine, { mode: "full" });
    await touch(r, "a.md", "3");
    const diff = await runOk(r.engine, { mode: "diff" });
    const { manifest } = await readBackupFolder(r.store, `backup/${diff.backupId}`);
    expect(manifest.baseId).toBe(second.backupId);
    await expectChainEqualsVault(r);
  });
});
