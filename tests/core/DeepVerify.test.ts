import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { isDeepVerifyDue, loadDeepVerifyRecord, runDeepVerify } from "../../src/core/DeepVerify";
import { LockManager } from "../../src/core/LockManager";
import { verifyAndRecord, type VerifyRunnerDeps } from "../../src/core/VerifyRunner";
import { enc, fastMaster, rig, runOk, seedVault, type Rig } from "../support/engineRig";

const DAY = 24 * 60 * 60 * 1000;

function runnerFor(r: Rig, extra: Partial<VerifyRunnerDeps> = {}): VerifyRunnerDeps {
  return {
    store: r.store,
    logger: r.logger,
    clock: r.clock,
    getProfile: () => r.profile,
    platform: "desktop",
    yieldIfNeeded: async () => undefined,
    lockOptions: { sleep: async () => undefined },
    ...extra,
  };
}

async function history(tweak?: Parameters<typeof rig>[0]): Promise<{ r: Rig; ids: string[] }> {
  const r = rig((p) => {
    p.verification.scheduledDeepVerify = true;
    p.verification.deepVerifyIntervalDays = 30;
    tweak?.(p);
  });
  await seedVault(r.store, 10);
  const ids: string[] = [];
  for (const mode of ["full", "diff", "diff"] as const) {
    r.clock.advance(60_000);
    await r.store.writeBinary("folder1/sub1/note-1.md", enc(`v ${r.clock.now()}`));
    ids.push((await runOk(r.engine, { mode })).backupId);
  }
  return { r, ids };
}

describe("isDeepVerifyDue", () => {
  it("is never due when the setting is off or there is nothing to verify", async () => {
    const { r } = await history((p) => void (p.verification.scheduledDeepVerify = false));
    expect(await isDeepVerifyDue(runnerFor(r))).toBe(false);
    const empty = rig((p) => void (p.verification.scheduledDeepVerify = true));
    expect(await isDeepVerifyDue(runnerFor(empty))).toBe(false);
  });

  it("is due when it has never run, then not until the interval has passed", async () => {
    const { r } = await history();
    const deps = runnerFor(r);
    expect(await isDeepVerifyDue(deps)).toBe(true);
    await runDeepVerify(deps);
    expect(await isDeepVerifyDue(deps)).toBe(false);
    r.clock.advance(29 * DAY);
    expect(await isDeepVerifyDue(deps)).toBe(false);
    r.clock.advance(1 * DAY);
    expect(await isDeepVerifyDue(deps)).toBe(true);
  });

  it("honours a changed interval, and an unreadable record counts as never run", async () => {
    const { r } = await history();
    await runDeepVerify(runnerFor(r));
    r.clock.advance(8 * DAY);
    r.profile.verification.deepVerifyIntervalDays = 7;
    expect(await isDeepVerifyDue(runnerFor(r))).toBe(true);
    await r.store.writeBinary("backup/deep-verify.json", enc("{ garbage"));
    r.profile.verification.deepVerifyIntervalDays = 365;
    expect(await loadDeepVerifyRecord(runnerFor(r), "backup")).toBeNull();
    expect(await isDeepVerifyDue(runnerFor(r))).toBe(true);
  });
});

describe("runDeepVerify", () => {
  it("verifies the newest intact backup at level 5 and records the run", async () => {
    const { r, ids } = await history();
    const report = await runDeepVerify(runnerFor(r));
    expect(report).toMatchObject({ backupId: ids[2], level: 5, result: "pass" });
    expect(report?.entriesChecked).toBeGreaterThan(10); // the whole chain was read
    expect(await loadDeepVerifyRecord(runnerFor(r), "backup")).toEqual({
      lastRunAt: r.clock.now(),
      backupId: ids[2],
      result: "pass",
    });
  });

  it("skips a corrupt newest backup and checks the newest intact one", async () => {
    const { r, ids } = await history();
    const index = await loadIndex(r.store, "backup");
    const idx = JSON.parse(JSON.stringify(index)) as typeof index;
    const entry = idx.backups.find((b) => b.id === ids[2]);
    if (entry) entry.status = "corrupt";
    await r.store.writeBinary("backup/index.json", enc(JSON.stringify(idx)));
    expect((await runDeepVerify(runnerFor(r)))?.backupId).toBe(ids[1]);
  });

  it("finds rot deep in the chain, marks that backup corrupt and records the failure", async () => {
    const { r, ids } = await history();
    const part = `backup/${ids[0]}/part-001.zip`;
    const bytes = (await r.store.readBinary(part)).slice();
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await r.store.writeBinary(part, bytes);

    const report = await runDeepVerify(runnerFor(r));
    expect(report?.result).toBe("fail");
    expect(report?.issues.every((i) => i.backupId === ids[0])).toBe(true);
    expect((await loadDeepVerifyRecord(runnerFor(r), "backup"))?.result).toBe("fail");
    // The verified (newest) backup is marked, since its chain cannot be restored.
    const statuses = (await loadIndex(r.store, "backup")).backups.map((b) => b.status);
    expect(statuses).toContain("corrupt");
  });

  it("returns null and changes nothing when a backup holds the lock, and tries again later", async () => {
    const { r } = await history();
    const other = new LockManager(r.store, "backup", r.clock, {
      timeoutMin: 30,
      platform: "desktop",
      sleep: async () => undefined,
    });
    await other.acquire();
    expect(await runDeepVerify(runnerFor(r))).toBeNull();
    expect(await loadDeepVerifyRecord(runnerFor(r), "backup")).toBeNull();
    expect(await isDeepVerifyDue(runnerFor(r))).toBe(true);
    await other.release();
    expect((await runDeepVerify(runnerFor(r)))?.result).toBe("pass");
  });

  it("releases the lock afterwards so backups can run", async () => {
    const { r } = await history();
    await runDeepVerify(runnerFor(r));
    r.clock.advance(60_000);
    await r.store.seed("after.md", "x");
    await runOk(r.engine, { mode: "diff" });
  });

  it("returns null when there is no intact backup", async () => {
    const empty = rig((p) => void (p.verification.scheduledDeepVerify = true));
    expect(await runDeepVerify(runnerFor(empty))).toBeNull();
  });

  it("checks encrypted backups when given the key source, notes skipped without it", async () => {
    const enc1 = (p: Parameters<NonNullable<Parameters<typeof rig>[0]>>[0]): void => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    };
    const { r } = await history(enc1);
    const withKey = await runDeepVerify(runnerFor(r, { deriveMasterKey: fastMaster }));
    expect(withKey?.skipped).toBeUndefined();
    const without = await runDeepVerify(runnerFor(r));
    expect(without?.skipped?.length).toBeGreaterThan(0);
  });
});

describe("verifyAndRecord", () => {
  it("verifies at the requested level under the lock and records the result in the manifest", async () => {
    const { r, ids } = await history();
    const report = await verifyAndRecord(runnerFor(r), ids[0] as string, { level: 3 });
    expect(report.result).toBe("pass");
    const raw = JSON.parse(
      new TextDecoder().decode(await r.store.readBinary(`backup/${ids[0]}/manifest.json`)),
    ) as { verify: { lastLevel: number; result: string } };
    expect(raw.verify).toMatchObject({ lastLevel: 3, result: "pass" });
    expect(await r.store.exists("backup/lock.json")).toBe(false);
  });
});
