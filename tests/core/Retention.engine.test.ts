import { describe, expect, it } from "vitest";
import { loadIndex, saveIndex, updateBackup } from "../../src/core/BackupIndex";
import { applyRetention } from "../../src/core/RetentionApply";
import { StorageError } from "../../src/helpers/errors";
import { reconstruct } from "../support/chain";
import { enc, rig, runOk, type Rig } from "../support/engineRig";

const MINUTE = 60_000;

async function backup(r: Rig, mode: "full" | "diff" = "full", options = {}) {
  r.clock.advance(MINUTE);
  await r.store.writeBinary("a.md", enc(`a at ${r.clock.now()}`));
  return runOk(r.engine, { mode, ...options });
}

async function seeded(keepLast: number, extra?: (p: Rig["profile"]) => void): Promise<Rig> {
  const r = rig((p) => {
    p.retention.keepLast = keepLast;
    extra?.(p);
  });
  await r.store.seed("a.md", "a");
  await r.store.seed("b.md", "b");
  return r;
}

const folders = async (r: Rig): Promise<string[]> =>
  (await r.store.list("backup")).folders.map((f) => f.slice("backup/".length)).sort();

describe("retention inside the backup engine", () => {
  it("keeps only the newest N backups and deletes the rest from disk and index", async () => {
    const r = await seeded(3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await backup(r)).backupId);

    expect(await folders(r)).toEqual(ids.slice(3).sort());
    const index = await loadIndex(r.store, "backup");
    expect(index.backups.map((b) => b.id).sort()).toEqual(ids.slice(3).sort());
  });

  it("reports what it removed on the run result, and nothing when nothing was pruned", async () => {
    const r = await seeded(2);
    const first = await backup(r);
    const second = await backup(r);
    expect(first.retention).toBeUndefined();
    expect(second.retention).toBeUndefined();
    const third = await backup(r);
    expect(third.retention?.pruned).toEqual([first.backupId]);
    expect(third.retention?.failed).toEqual([]);
  });

  it("the surviving backups still restore the vault exactly", async () => {
    const r = await seeded(2);
    await backup(r);
    await backup(r);
    const last = await backup(r);
    const index = await loadIndex(r.store, "backup");
    const files = await reconstruct(r.store, "backup", [last.backupId]);
    expect(index.backups).toHaveLength(2);
    expect(new TextDecoder().decode(files.get("a.md"))).toBe(`a at ${r.clock.now()}`);
  });

  it("keep last 0 disables pruning entirely", async () => {
    const r = await seeded(0);
    for (let i = 0; i < 5; i++) await backup(r);
    expect(await folders(r)).toHaveLength(5);
  });

  it("never runs after a non-destructive backup", async () => {
    const r = await seeded(1);
    await backup(r);
    await backup(r);
    await backup(r);
    expect(await folders(r)).toHaveLength(1);
    // Raise the limit, add history, then lower it again: a non-destructive run must not prune.
    r.profile.retention.keepLast = 0;
    await backup(r);
    await backup(r);
    r.profile.retention.keepLast = 1;
    const before = await folders(r);
    const result = await backup(r, "diff", { nonDestructive: true });
    expect(result.retention).toBeUndefined();
    expect((await folders(r)).length).toBe(before.length + 1);
  });

  it("a skipped run (nothing changed) does not prune", async () => {
    const r = await seeded(1);
    await backup(r, "full");
    r.profile.retention.keepLast = 0;
    await backup(r, "full");
    r.profile.retention.keepLast = 1;
    const before = await folders(r);
    expect((await r.engine.run({ mode: "diff" })).status).toBe("skipped");
    expect(await folders(r)).toEqual(before);
  });

  it("does not count a corrupt backup, and never deletes it", async () => {
    const r = await seeded(2);
    const a = await backup(r);
    const b = await backup(r);
    let index = await loadIndex(r.store, "backup");
    index = updateBackup(index, b.backupId, { status: "corrupt" });
    await saveIndex(r.store, "backup", index);
    const c = await backup(r); // intact: a, c ; corrupt: b
    const after = await loadIndex(r.store, "backup");
    expect(after.backups.map((x) => x.id).sort()).toEqual(
      [a.backupId, b.backupId, c.backupId].sort(),
    );
    const d = await backup(r); // intact: a, c, d -> a is pruned; corrupt b stays
    expect(d.retention?.pruned).toEqual([a.backupId]);
    expect(await folders(r)).toEqual([b.backupId, c.backupId, d.backupId].sort());
  });

  it("a failing retention step never fails the backup that was just made", async () => {
    const r = await seeded(1);
    const first = await backup(r);
    const original = r.store.removeFolder.bind(r.store);
    r.store.removeFolder = async (path: string) => {
      if (path.endsWith(first.backupId)) throw new StorageError(path, "Cannot remove folder");
      return original(path);
    };
    const second = await backup(r);
    expect(second.retention).toEqual({ pruned: [], failed: [first.backupId] });
    expect(r.logger.messages("warn").some((m) => m.includes("could not delete"))).toBe(true);
    // Unregistered but still on disk: harmless leftover, the new backup is intact.
    const index = await loadIndex(r.store, "backup");
    expect(index.backups.map((b) => b.id)).toEqual([second.backupId]);
    expect(await folders(r)).toContain(first.backupId);
  });
});

describe("applyRetention", () => {
  it("saves the index BEFORE deleting folders (a crash leaves a leftover folder, not a dangling entry)", async () => {
    const r = await seeded(0);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await backup(r)).backupId);
    const events: string[] = [];
    const removeFolder = r.store.removeFolder.bind(r.store);
    r.store.removeFolder = async (path: string) => {
      events.push(`remove:${(await loadIndex(r.store, "backup")).backups.length}`);
      return removeFolder(path);
    };
    await applyRetention({
      store: r.store,
      logger: r.logger,
      backupFolder: "backup",
      settings: { ...r.profile.retention, keepLast: 1 },
      now: r.clock.now(),
    });
    // When the first folder is deleted the index already lists only the survivor.
    expect(events).toEqual(["remove:1", "remove:1"]);
  });

  it("does nothing on an empty backup folder", async () => {
    const r = await seeded(1);
    const result = await applyRetention({
      store: r.store,
      logger: r.logger,
      backupFolder: "backup",
      settings: r.profile.retention,
      now: r.clock.now(),
    });
    expect(result).toEqual({ pruned: [], failed: [] });
  });
});
