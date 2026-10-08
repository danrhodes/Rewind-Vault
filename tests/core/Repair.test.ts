import { describe, expect, it } from "vitest";
import { BackupAdmin } from "../../src/core/BackupAdmin";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadManifest } from "../../src/core/Manifest";
import { RECOVERY_SUFFIX } from "../../src/core/RecoveryRecord";
import { verifyAndRecord, type VerifyRunnerDeps } from "../../src/core/VerifyRunner";
import { fastMaster, rig, runOk, type Rig } from "../support/engineRig";

/** Incompressible content so one part spans several 64 KB recovery blocks. */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

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

const verifier = (r: Rig): VerifyRunnerDeps => ({
  store: r.store,
  logger: r.logger,
  clock: r.clock,
  getProfile: () => r.profile,
  platform: "desktop",
  deriveMasterKey: fastMaster,
  yieldIfNeeded: async () => undefined,
  lockOptions: { sleep: async () => undefined },
});

async function setup(percent = 40, tweak: (r: Rig) => void = () => undefined) {
  const r = rig((p) => {
    p.zip.recoveryPercent = percent;
    p.zip.compressionLevel = 0; // keep the part big so it has several blocks
  });
  tweak(r);
  await r.store.seed("a.md", "hello");
  await r.store.writeBinary("big1.bin", noise(150 * 1024, 1));
  await r.store.writeBinary("big2.bin", noise(150 * 1024, 2));
  const { backupId } = await runOk(r.engine, { mode: "full" });
  const manifest = await loadManifest(r.store, `backup/${backupId}`);
  const part = manifest.parts[0]?.name as string;
  return { r, backupId, part, partPath: `backup/${backupId}/${part}` };
}

async function flip(r: Rig, path: string, at: number, length = 1): Promise<void> {
  const data = await r.store.readBinary(path);
  for (let i = 0; i < length; i++) data[at + i] = (data[at + i] as number) ^ 0xff;
  await r.store.writeBinary(path, data);
}

describe("recovery records are written next to each part", () => {
  it("only when the setting is on", async () => {
    const on = await setup(20);
    expect(await on.r.store.exists(`${on.partPath}${RECOVERY_SUFFIX}`)).toBe(true);
    const off = await setup(0);
    expect(await off.r.store.exists(`${off.partPath}${RECOVERY_SUFFIX}`)).toBe(false);
  });

  it("do not change the backup itself: it still verifies, and the manifest does not list them", async () => {
    const t = await setup(20);
    const report = await verifyAndRecord(verifier(t.r), t.backupId, { level: 3 });
    expect(report.result).toBe("pass");
    const manifest = await loadManifest(t.r.store, `backup/${t.backupId}`);
    expect(manifest.parts.map((p) => p.name)).toEqual([t.part]);
  });

  it("go away with the backup when it is deleted", async () => {
    const t = await setup(20);
    await admin(t.r).deleteBackup(t.backupId, { force: true });
    expect(await t.r.store.exists(`${t.partPath}${RECOVERY_SUFFIX}`)).toBe(false);
  });
});

describe("repairBackup", () => {
  it("rebuilds a damaged part, byte for byte, and marks the backup intact again", async () => {
    const t = await setup(40);
    const original = await t.r.store.readBinary(t.partPath);
    await flip(t.r, t.partPath, 70 * 1024, 300); // damage inside one block
    const broken = await verifyAndRecord(verifier(t.r), t.backupId, { level: 3 });
    expect(broken.result).toBe("fail");
    expect((await loadIndex(t.r.store, "backup")).backups[0]?.status).toBe("corrupt");

    const report = await admin(t.r).repairBackup(t.backupId);
    expect(report).toMatchObject({ repaired: [t.part], failed: [], healed: true });
    const fixed = await t.r.store.readBinary(t.partPath);
    expect(fixed.length).toBe(original.length);
    expect(fixed.every((b, i) => b === original[i])).toBe(true);
    expect((await loadIndex(t.r.store, "backup")).backups[0]?.status).toBe("ok");
    expect((await loadManifest(t.r.store, `backup/${t.backupId}`)).status).toBe("ok");
    expect((await verifyAndRecord(verifier(t.r), t.backupId, { level: 3 })).result).toBe("pass");
  });

  it("repairs a part that was cut short or deleted", async () => {
    const t = await setup(50);
    const original = await t.r.store.readBinary(t.partPath);
    await t.r.store.writeBinary(t.partPath, original.slice(0, original.length - 90_000));
    expect((await admin(t.r).repairBackup(t.backupId)).repaired).toEqual([t.part]);
    expect((await verifyAndRecord(verifier(t.r), t.backupId, { level: 3 })).result).toBe("pass");
  });

  it("reports an intact backup as such and changes nothing", async () => {
    const t = await setup(20);
    const before = await t.r.store.readBinary(t.partPath);
    const report = await admin(t.r).repairBackup(t.backupId);
    expect(report).toEqual({
      backupId: t.backupId,
      repaired: [],
      intact: [t.part],
      failed: [],
      healed: false,
    });
    expect((await t.r.store.readBinary(t.partPath)).length).toBe(before.length);
  });

  it("fails clearly when too much is damaged, and leaves the damaged file alone", async () => {
    const t = await setup(20); // 5 blocks -> 1 parity block
    await flip(t.r, t.partPath, 10, 20);
    await flip(t.r, t.partPath, 130 * 1024, 20);
    await flip(t.r, t.partPath, 250 * 1024, 20);
    const damaged = await t.r.store.readBinary(t.partPath);
    const report = await admin(t.r).repairBackup(t.backupId);
    expect(report.repaired).toEqual([]);
    expect(report.failed[0]?.part).toBe(t.part);
    expect(report.failed[0]?.reason).toContain("can rebuild at most");
    expect(report.healed).toBe(false);
    const after = await t.r.store.readBinary(t.partPath);
    expect(after.every((b, i) => b === damaged[i])).toBe(true);
  });

  it("fails clearly when there is no recovery record", async () => {
    const t = await setup(0);
    await flip(t.r, t.partPath, 100, 5);
    const report = await admin(t.r).repairBackup(t.backupId);
    expect(report.failed[0]?.reason).toBe("There is no recovery record for this part");
  });

  it("does not trust a damaged record", async () => {
    const t = await setup(40);
    await flip(t.r, t.partPath, 100, 5);
    await flip(t.r, `${t.partPath}${RECOVERY_SUFFIX}`, 20, 5); // header
    const report = await admin(t.r).repairBackup(t.backupId);
    expect(report.failed[0]?.reason).toBe("The recovery record is damaged");
  });

  it("rejects an unknown backup", async () => {
    const t = await setup(20);
    await expect(admin(t.r).repairBackup("nope")).rejects.toThrow(/not in the backup index/);
  });

  it("works on encrypted backups (the records cover the stored bytes)", async () => {
    const t = await setup(40, (r) => {
      r.profile.encryption.enabled = true;
      r.profile.encryption.passphrase = "pw";
    });
    await flip(t.r, t.partPath, 80 * 1024, 100);
    const report = await admin(t.r).repairBackup(t.backupId);
    expect(report.repaired).toEqual([t.part]);
    expect(report.healed).toBe(false); // it was never marked damaged
  });
});
