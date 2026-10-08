import { describe, expect, it } from "vitest";
import { BackupAdmin } from "../../src/core/BackupAdmin";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadState } from "../../src/core/BackupState";
import { LockManager } from "../../src/core/LockManager";
import { LockError } from "../../src/helpers/errors";
import { enc, rig, runOk, type Rig } from "../support/engineRig";

const admin = (r: Rig): BackupAdmin =>
  new BackupAdmin({
    store: r.store,
    logger: r.logger,
    clock: r.clock,
    backupFolder: "backup",
    lockTimeoutMin: 30,
    platform: "desktop",
    lockOptions: { sleep: async () => undefined },
  });

async function withBackup() {
  const r = rig();
  await r.store.seed("a.md", "one");
  r.clock.advance(60_000);
  const first = await runOk(r.engine, { mode: "full" });
  return { r, first };
}

describe("BackupAdmin.resetState", () => {
  it("clears the saved file state and keeps every backup", async () => {
    const { r, first } = await withBackup();
    expect((await loadState(r.store, "backup")).updatedAt).toBeGreaterThan(0);
    await admin(r).resetState();
    const state = await loadState(r.store, "backup");
    expect(state.updatedAt).toBe(0);
    expect(Object.keys(state.files)).toEqual([]);
    const index = await loadIndex(r.store, "backup");
    expect(index.backups.map((b) => b.id)).toEqual([first.backupId]);
    expect(await r.store.exists(`backup/${first.backupId}`)).toBe(true);
  });

  it("forces the next differential to be a full backup, even with no changes", async () => {
    const { r } = await withBackup();
    r.clock.advance(60_000);
    expect((await r.engine.run({ mode: "diff" })).status).toBe("skipped");
    await admin(r).resetState();
    r.clock.advance(60_000);
    const next = await runOk(r.engine, { mode: "diff" });
    expect(next.type).toBe("full");
    expect(next.forcedFullReason).toBe("there is no previous backup state");
    // Later differentials build on the new full backup again.
    r.clock.advance(60_000);
    await r.store.writeBinary("a.md", enc("two"));
    expect((await runOk(r.engine, { mode: "diff" })).type).toBe("diff");
  });

  it("works before any backup exists", async () => {
    const r = rig();
    await admin(r).resetState();
    expect((await loadState(r.store, "backup")).updatedAt).toBe(0);
  });

  it("is refused while a backup holds the lock", async () => {
    const { r } = await withBackup();
    const lock = new LockManager(r.store, "backup", r.clock, {
      timeoutMin: 30,
      platform: "desktop",
      sleep: async () => undefined,
    });
    await lock.acquire();
    await expect(admin(r).resetState()).rejects.toBeInstanceOf(LockError);
    await lock.release();
  });
});
