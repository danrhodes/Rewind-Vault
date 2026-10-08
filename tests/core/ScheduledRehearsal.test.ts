import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { LockManager } from "../../src/core/LockManager";
import {
  isRehearsalDue,
  loadRehearsalRecord,
  runScheduledRehearsal,
} from "../../src/core/ScheduledRehearsal";
import type { VerifyRunnerDeps } from "../../src/core/VerifyRunner";
import { enc, fastMaster, rig, runOk, seedVault, type Rig } from "../support/engineRig";

const DAY = 24 * 60 * 60 * 1000;

function runnerFor(r: Rig, extra: Partial<VerifyRunnerDeps> = {}): VerifyRunnerDeps {
  return {
    store: r.store,
    logger: r.logger,
    clock: r.clock,
    getProfile: () => r.profile,
    platform: "desktop",
    deriveMasterKey: fastMaster,
    yieldIfNeeded: async () => undefined,
    lockOptions: { sleep: async () => undefined },
    ...extra,
  };
}

async function history(tweak?: Parameters<typeof rig>[0]): Promise<{ r: Rig; ids: string[] }> {
  const r = rig((p) => {
    p.verification.scheduledRehearsal = true;
    p.verification.rehearsalIntervalDays = 30;
    tweak?.(p);
  });
  await seedVault(r.store, 10);
  const ids: string[] = [];
  for (const mode of ["full", "diff"] as const) {
    r.clock.advance(60_000);
    await r.store.writeBinary("folder1/sub1/note-1.md", enc(`v ${r.clock.now()}`));
    ids.push((await runOk(r.engine, { mode })).backupId);
  }
  return { r, ids };
}

describe("isRehearsalDue", () => {
  it("is never due when the setting is off or there is nothing to rehearse", async () => {
    const { r } = await history((p) => void (p.verification.scheduledRehearsal = false));
    expect(await isRehearsalDue(runnerFor(r), () => true)).toBe(false);
    const empty = rig((p) => void (p.verification.scheduledRehearsal = true));
    expect(await isRehearsalDue(runnerFor(empty), () => true)).toBe(false);
  });

  it("is due when never run, then not until the interval has passed (monthly by default)", async () => {
    const { r } = await history();
    const deps = runnerFor(r);
    expect(await isRehearsalDue(deps, () => true)).toBe(true);
    await runScheduledRehearsal(deps);
    expect(await isRehearsalDue(deps, () => true)).toBe(false);
    r.clock.advance(29 * DAY);
    expect(await isRehearsalDue(deps, () => true)).toBe(false);
    r.clock.advance(DAY);
    expect(await isRehearsalDue(deps, () => true)).toBe(true);
  });

  it("does not run an encrypted rehearsal unless a passphrase is available without asking", async () => {
    const { r } = await history((p) => void (p.encryption.enabled = true));
    expect(await isRehearsalDue(runnerFor(r), () => false)).toBe(false);
    expect(await isRehearsalDue(runnerFor(r), () => true)).toBe(true);
  });
});

describe("runScheduledRehearsal", () => {
  it("rehearses the newest intact backup at level 6 and records the outcome", async () => {
    const { r, ids } = await history();
    const report = await runScheduledRehearsal(runnerFor(r));
    expect(report).toMatchObject({ backupId: ids[1], level: 6, result: "pass" });
    expect(report?.rehearsal?.filesRestored).toBeGreaterThan(0);
    expect(await loadRehearsalRecord(runnerFor(r), "backup")).toEqual({
      lastRunAt: r.clock.now(),
      backupId: ids[1],
      result: "pass",
    });
  });

  it("marks a damaged backup corrupt and records the failure", async () => {
    const { r, ids } = await history();
    const part = `backup/${ids[1]}/part-001.zip`;
    const data = await r.store.readBinary(part);
    data[Math.floor(data.length / 2)] = (data[Math.floor(data.length / 2)] ?? 0) ^ 0xff;
    await r.store.writeBinary(part, data);
    const report = await runScheduledRehearsal(runnerFor(r));
    expect(report?.result).toBe("fail");
    expect((await loadRehearsalRecord(runnerFor(r), "backup"))?.result).toBe("fail");
    expect((await loadIndex(r.store, "backup")).backups.find((b) => b.id === ids[1])?.status).toBe(
      "corrupt",
    );
  });

  it("returns null and records nothing while a backup holds the lock", async () => {
    const { r } = await history();
    const lock = new LockManager(r.store, "backup", r.clock, {
      timeoutMin: 30,
      platform: "desktop",
      sleep: async () => undefined,
    });
    await lock.acquire();
    expect(await runScheduledRehearsal(runnerFor(r))).toBeNull();
    await lock.release();
    expect(await loadRehearsalRecord(runnerFor(r), "backup")).toBeNull();
  });

  it("returns null with no backups and treats an unreadable record as never run", async () => {
    const empty = rig();
    expect(await runScheduledRehearsal(runnerFor(empty))).toBeNull();
    const { r } = await history();
    await r.store.seed("backup/rehearsal.json", "garbage");
    expect(await loadRehearsalRecord(runnerFor(r), "backup")).toBeNull();
    expect(await isRehearsalDue(runnerFor(r), () => true)).toBe(true);
  });
});
