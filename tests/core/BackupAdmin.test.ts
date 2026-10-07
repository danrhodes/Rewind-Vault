import { describe, expect, it } from "vitest";
import { BackupAdmin, deleteImpact, dependentsOf } from "../../src/core/BackupAdmin";
import { loadIndex } from "../../src/core/BackupIndex";
import { BackupAdminError, LockError } from "../../src/helpers/errors";
import { reconstruct } from "../support/chain";
import { enc, rig, runOk, type Rig } from "../support/engineRig";
import { DAY, indexOf } from "../support/retentionFixtures";

function admin(r: Rig): BackupAdmin {
  return new BackupAdmin({
    store: r.store,
    logger: r.logger,
    clock: r.clock,
    backupFolder: "backup",
    lockTimeoutMin: 30,
    platform: "desktop",
    lockOptions: { sleep: async () => undefined },
  });
}

/** One full backup followed by `diffs` differential backups. */
async function chain(diffs: number): Promise<{ r: Rig; ids: string[] }> {
  const r = rig((p) => {
    p.retention.keepLast = 100;
  });
  await r.store.seed("a.md", "start");
  const ids: string[] = [];
  r.clock.advance(60_000);
  ids.push((await runOk(r.engine, { mode: "full" })).backupId);
  for (let i = 0; i < diffs; i++) {
    r.clock.advance(60_000);
    await r.store.writeBinary("a.md", enc(`edit ${i}`));
    ids.push((await runOk(r.engine, { mode: "diff" })).backupId);
  }
  return { r, ids };
}

const folders = async (r: Rig): Promise<string[]> =>
  (await r.store.list("backup")).folders.map((f) => f.slice("backup/".length)).sort();

describe("dependentsOf / deleteImpact (pure)", () => {
  const index = indexOf(
    { id: "F1", age: 6 * DAY },
    { id: "D1", age: 5 * DAY, type: "diff", baseId: "F1" },
    { id: "D2", age: 4 * DAY, type: "diff", baseId: "F1" },
    { id: "F2", age: 3 * DAY },
    { id: "D3", age: 2 * DAY, type: "diff", baseId: "F2" },
  );

  it("a base and an early diff have the later diffs of their chain as dependents", () => {
    expect(
      dependentsOf(index, "F1")
        .map((b) => b.id)
        .sort(),
    ).toEqual(["D1", "D2"]);
    expect(dependentsOf(index, "D1").map((b) => b.id)).toEqual(["D2"]);
    expect(dependentsOf(index, "D2")).toEqual([]);
    expect(dependentsOf(index, "F2").map((b) => b.id)).toEqual(["D3"]);
  });

  it("describes the impact, including pinned and last-intact", () => {
    expect(deleteImpact(index, "D2")).toMatchObject({ pinned: false, lastIntact: false });
    const pinned = indexOf(
      { id: "F", age: 3 * DAY },
      { id: "D", age: 2 * DAY, type: "diff", baseId: "F", pinned: true },
    );
    expect(deleteImpact(pinned, "F").pinned).toBe(true); // a pinned dependent counts
    const only = indexOf({ id: "F", age: DAY });
    expect(deleteImpact(only, "F").lastIntact).toBe(true);
    const withCorrupt = indexOf(
      { id: "F", age: 2 * DAY },
      { id: "bad", age: DAY, status: "corrupt" },
    );
    expect(deleteImpact(withCorrupt, "F").lastIntact).toBe(true);
    expect(deleteImpact(withCorrupt, "bad").lastIntact).toBe(false);
  });

  it("an unknown id is a BackupAdminError", () => {
    expect(() => deleteImpact(index, "nope")).toThrow(BackupAdminError);
  });
});

describe("BackupAdmin.setPinned", () => {
  it("pins with a label, and unpinning clears the label", async () => {
    const { r, ids } = await chain(1);
    await admin(r).setPinned(ids[0]!, true, "  v1.0  ");
    let entry = (await loadIndex(r.store, "backup")).backups.find((b) => b.id === ids[0]);
    expect(entry).toMatchObject({ pinned: true, label: "v1.0" });
    await admin(r).setPinned(ids[0]!, false);
    entry = (await loadIndex(r.store, "backup")).backups.find((b) => b.id === ids[0]);
    expect(entry?.pinned).toBe(false);
    expect(entry?.label).toBeUndefined();
  });

  it("pinning without a label keeps any existing label", async () => {
    const { r, ids } = await chain(0);
    await admin(r).setPinned(ids[0]!, true, "keep me");
    await admin(r).setPinned(ids[0]!, true);
    expect((await loadIndex(r.store, "backup")).backups[0]?.label).toBe("keep me");
  });

  it("an unknown backup is refused and the index is unchanged", async () => {
    const { r } = await chain(0);
    const before = JSON.stringify(await loadIndex(r.store, "backup"));
    await expect(admin(r).setPinned("nope", true)).rejects.toThrow();
    expect(JSON.stringify(await loadIndex(r.store, "backup"))).toBe(before);
  });
});

describe("BackupAdmin.deleteBackup", () => {
  it("deletes a newest diff: folder and index entry gone, the rest untouched", async () => {
    const { r, ids } = await chain(2);
    const removed = await admin(r).deleteBackup(ids[2]!);
    expect(removed).toEqual([ids[2]]);
    expect(await folders(r)).toEqual([ids[0]!, ids[1]!].sort());
    expect((await loadIndex(r.store, "backup")).backups.map((b) => b.id).sort()).toEqual(
      [ids[0]!, ids[1]!].sort(),
    );
  });

  it("refuses to delete a backup that others depend on unless cascade is set", async () => {
    const { r, ids } = await chain(2);
    await expect(admin(r).deleteBackup(ids[0]!)).rejects.toThrow(BackupAdminError);
    await expect(admin(r).deleteBackup(ids[1]!)).rejects.toThrow(/depend/);
    expect(await folders(r)).toHaveLength(3); // nothing was removed
  });

  it("cascade removes the backup and everything built on it", async () => {
    const { r, ids } = await chain(2);
    const removed = await admin(r).deleteBackup(ids[1]!, { cascade: true });
    expect(removed.sort()).toEqual([ids[1]!, ids[2]!].sort());
    expect(await folders(r)).toEqual([ids[0]!]);
  });

  it("cascade from the base removes the whole chain", async () => {
    const { r, ids } = await chain(2);
    await admin(r).deleteBackup(ids[0]!, { cascade: true });
    expect(await folders(r)).toEqual([]);
    expect((await loadIndex(r.store, "backup")).backups).toEqual([]);
  });

  it("refuses to touch a pinned backup unless forced", async () => {
    const { r, ids } = await chain(1);
    await admin(r).setPinned(ids[1]!, true);
    await expect(admin(r).deleteBackup(ids[1]!)).rejects.toThrow(/pinned/);
    await expect(admin(r).deleteBackup(ids[0]!, { cascade: true })).rejects.toThrow(/pinned/);
    expect(await folders(r)).toHaveLength(2);
    await admin(r).deleteBackup(ids[1]!, { force: true });
    expect(await folders(r)).toEqual([ids[0]!]);
  });

  it("saves the index before deleting folders, and survives a folder that will not delete", async () => {
    const { r, ids } = await chain(1);
    const original = r.store.removeFolder.bind(r.store);
    let indexWhenRemoving = -1;
    r.store.removeFolder = async (path: string) => {
      indexWhenRemoving = (await loadIndex(r.store, "backup")).backups.length;
      throw new Error(`denied ${path}`);
    };
    const removed = await admin(r).deleteBackup(ids[1]!);
    expect(indexWhenRemoving).toBe(1);
    expect(removed).toEqual([]); // unregistered, folder left behind
    expect((await loadIndex(r.store, "backup")).backups.map((b) => b.id)).toEqual([ids[0]]);
    expect(r.logger.messages("warn").join(" ")).toContain("could not be deleted");
    r.store.removeFolder = original;
  });

  it("the remaining chain still restores exactly after the newest diff is deleted", async () => {
    const { r, ids } = await chain(2);
    await admin(r).deleteBackup(ids[2]!);
    const files = await reconstruct(r.store, "backup", [ids[0]!, ids[1]!]);
    expect(new TextDecoder().decode(files.get("a.md"))).toBe("edit 0");
  });
});

describe("BackupAdmin locking", () => {
  it("is refused with a LockError while a backup holds the lock, and changes nothing", async () => {
    const { r, ids } = await chain(1);
    await r.store.writeBinary(
      "backup/lock.json",
      enc(
        JSON.stringify({
          schemaVersion: 1,
          ownerId: "someone-else",
          platform: "desktop",
          acquiredAt: r.clock.now(),
          heartbeatAt: r.clock.now(),
        }),
      ),
    );
    await expect(admin(r).setPinned(ids[0]!, true)).rejects.toThrow(LockError);
    await expect(admin(r).deleteBackup(ids[1]!)).rejects.toThrow(LockError);
    expect(await folders(r)).toHaveLength(2);
  });

  it("releases the lock after success and after a refusal", async () => {
    const { r, ids } = await chain(1);
    await admin(r).setPinned(ids[0]!, true);
    await expect(admin(r).deleteBackup(ids[0]!, { cascade: true })).rejects.toThrow();
    expect(await r.store.exists("backup/lock.json")).toBe(false);
  });
});
