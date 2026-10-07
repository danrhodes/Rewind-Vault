import { describe, expect, it } from "vitest";
import { BackupEngine } from "../../src/core/BackupEngine";
import { loadIndex } from "../../src/core/BackupIndex";
import { checkpointPath, loadCheckpoint } from "../../src/core/Checkpoint";
import { importAesKey } from "../../src/crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../../src/crypto/kdf";
import { verifyManifestSignature } from "../../src/crypto/sign";
import { fromBase64 } from "../../src/helpers/bytes";
import { createDefaultProfile } from "../../src/settings/defaults";
import { MockClock } from "../mocks/MockClock";
import { MockLogger } from "../mocks/MockLogger";
import { MockVaultStore } from "../mocks/MockVaultStore";
import { idsOf, reconstruct } from "../support/chain";
import { DyingStore } from "../support/dyingStore";
import { fastMaster, runOk, seedVault } from "../support/engineRig";
import { readBackupFolder } from "../support/readBackup";
import type { SettingsProfile } from "../../src/types";

const MIN = 60_000;

interface World {
  raw: MockVaultStore;
  clock: MockClock;
  profile: SettingsProfile;
  logger: MockLogger;
  /** A fresh engine on the same persisted data, like restarting the app. */
  engineOn: (store?: DyingStore | MockVaultStore) => BackupEngine;
}

function world(tweak: (p: SettingsProfile) => void = () => undefined): World {
  const clock = new MockClock(Date.UTC(2026, 9, 7, 21, 24, 0));
  const raw = new MockVaultStore(clock);
  const profile = createDefaultProfile("desktop");
  profile.zip.maxFilesPerZip = 3;
  tweak(profile);
  const logger = new MockLogger();
  const engineOn = (store: DyingStore | MockVaultStore = raw): BackupEngine =>
    new BackupEngine({
      store,
      logger,
      clock,
      getProfile: () => profile,
      platform: "desktop",
      pluginVersion: "0.0.1",
      deriveMasterKey: fastMaster,
      yieldIfNeeded: async () => undefined,
      lockOptions: { sleep: async () => undefined },
    });
  return { raw, clock, profile, logger, engineOn };
}

const killOnPartWrite = (partNumber: number) => {
  let seen = 0;
  return (_n: number, kind: string, path: string): boolean =>
    kind === "writeBinary" && /part-\d+\.zip\.tmp$/.test(path) && ++seen === partNumber;
};

async function liveVault(raw: MockVaultStore): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const walk = async (folder: string): Promise<void> => {
    const l = await raw.list(folder);
    for (const f of l.files) if (!f.startsWith("backup/")) out.set(f, await raw.readBinary(f));
    for (const d of l.folders) if (d !== "backup") await walk(d);
  };
  await walk("");
  return out;
}

describe("checkpoint and resume", () => {
  it("a killed run leaves a checkpoint, and resume finishes it without repacking done parts", async () => {
    const w = world();
    await seedVault(w.raw, 12); // 4 parts of 3 files
    const dying = new DyingStore(w.raw, killOnPartWrite(3));
    await expect(w.engineOn(dying).run({ mode: "full" })).rejects.toThrow("killed");
    expect(dying.isDead).toBe(true);

    // What a kill leaves behind: folder with 2 finished parts, a checkpoint, a lock.
    const cp = (await loadCheckpoint(w.raw, "backup"))!;
    expect(cp.nextPartIndex).toBe(2);
    expect(cp.parts.map((p) => p.name)).toEqual(["part-001.zip", "part-002.zip"]);
    expect((await loadIndex(w.raw, "backup")).backups).toEqual([]);
    expect(await w.raw.exists("backup/lock.json")).toBe(true);

    // App restarts after the stale lock has expired.
    w.clock.advance(31 * MIN);
    const engine = w.engineOn();
    expect(await engine.findResumable()).toMatchObject({
      backupId: cp.plan.id,
      type: "full",
      partsDone: 2,
      partsTotal: 4,
    });

    const reads: string[] = [];
    const read = w.raw.readBinary.bind(w.raw);
    w.raw.readBinary = async (p) => (reads.push(p), read(p));
    const result = await engine.resume({ mode: "full" });

    expect(result).toMatchObject({ status: "completed", backupId: cp.plan.id, fileCount: 12 });
    const sourceReads = reads.filter((p) => !p.startsWith("backup/"));
    expect(sourceReads).toHaveLength(6); // only parts 3 and 4
    expect(new Set(sourceReads).size).toBe(6);

    const { manifest, files } = await readBackupFolder(w.raw, `backup/${cp.plan.id}`);
    expect(files).toEqual(await liveVault(w.raw));
    expect(manifest.parts.map((p) => p.name)).toEqual([
      "part-001.zip",
      "part-002.zip",
      "part-003.zip",
      "part-004.zip",
    ]);
    expect(manifest.parts.map((p) => p.entryCount)).toEqual([3, 3, 3, 3]);
    expect(await w.raw.exists(checkpointPath("backup"))).toBe(false);
    expect(await w.raw.exists("backup/lock.json")).toBe(false);
    expect((await loadIndex(w.raw, "backup")).backups.map((b) => b.id)).toEqual([cp.plan.id]);
    expect(await engine.findResumable()).toBeNull();
  });

  it("KILL SWEEP: killing at every single write, then resuming, always yields a correct backup", async () => {
    // First, learn how many mutations a clean run performs.
    const probe = world();
    await seedVault(probe.raw, 8);
    const counter = new DyingStore(probe.raw, () => false);
    await runOk(probe.engineOn(counter), { mode: "full" });
    const total = counter.mutationCount;
    expect(total).toBeGreaterThan(10);

    for (let killAt = 1; killAt <= total; killAt++) {
      const w = world();
      await seedVault(w.raw, 8);
      const dying = new DyingStore(w.raw, (n) => n === killAt);
      await expect(w.engineOn(dying).run({ mode: "full" })).rejects.toThrow();

      w.clock.advance(31 * MIN);
      const result = await w.engineOn().resume({ mode: "full" });
      expect(result.status, `kill ${killAt}/${total}`).toBe("completed");

      const index = await loadIndex(w.raw, "backup");
      const restored = await reconstruct(w.raw, "backup", idsOf(index));
      expect(restored, `kill ${killAt}/${total}`).toEqual(await liveVault(w.raw));
      expect(await w.raw.exists(checkpointPath("backup"))).toBe(false);
    }
  });

  it("falls back to a fresh backup when a finished part was damaged, and cleans up the old folder", async () => {
    const w = world();
    await seedVault(w.raw, 12);
    const dying = new DyingStore(w.raw, killOnPartWrite(3));
    await expect(w.engineOn(dying).run({ mode: "full" })).rejects.toThrow();
    const cp = (await loadCheckpoint(w.raw, "backup"))!;

    const bad = await w.raw.readBinary(`backup/${cp.plan.folder}/part-001.zip`);
    bad[10] = (bad[10] ?? 0) ^ 0xff;
    await w.raw.writeBinary(`backup/${cp.plan.folder}/part-001.zip`, bad);

    w.clock.advance(31 * MIN);
    const result = await w.engineOn().resume({ mode: "full" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.backupId).not.toBe(cp.plan.id);
    expect(await w.raw.exists(`backup/${cp.plan.folder}`)).toBe(false);
    expect(w.logger.messages("warn").join()).toContain("Cannot resume");
    const index = await loadIndex(w.raw, "backup");
    expect(await reconstruct(w.raw, "backup", idsOf(index))).toEqual(await liveVault(w.raw));
  });

  it("a normal run discards an unfinished backup instead of piling up folders", async () => {
    const w = world();
    await seedVault(w.raw, 12);
    await expect(
      w.engineOn(new DyingStore(w.raw, killOnPartWrite(3))).run({ mode: "full" }),
    ).rejects.toThrow();
    const dead = (await loadCheckpoint(w.raw, "backup"))!.plan.folder;

    w.clock.advance(31 * MIN);
    await runOk(w.engineOn(), { mode: "full" });
    expect(await w.raw.exists(`backup/${dead}`)).toBe(false);
    expect((await w.raw.list("backup")).folders).toHaveLength(1);
    expect(await w.raw.exists(checkpointPath("backup"))).toBe(false);
  });

  it("resume with nothing to resume simply makes a fresh backup", async () => {
    const w = world();
    await seedVault(w.raw, 4);
    expect(await w.engineOn().findResumable()).toBeNull();
    const result = await w.engineOn().resume({ mode: "full" });
    expect(result).toMatchObject({ status: "completed", fileCount: 4 });
  });

  it("a leftover checkpoint for a backup that did finish is ignored and removed", async () => {
    const w = world();
    await seedVault(w.raw, 4);
    // Kill after the manifest, index and state are saved but before the checkpoint is cleared.
    const dying = new DyingStore(
      w.raw,
      (_n, kind, path) => kind === "remove" && path.endsWith("checkpoint.json"),
    );
    await expect(w.engineOn(dying).run({ mode: "full" })).rejects.toThrow();
    expect(await w.raw.exists(checkpointPath("backup"))).toBe(true);
    expect((await loadIndex(w.raw, "backup")).backups).toHaveLength(1);

    w.clock.advance(31 * MIN);
    expect(await w.engineOn().findResumable()).toBeNull();
    const result = await w.engineOn().resume({ mode: "diff" });
    expect(result.status).toBe("completed");
    expect(await w.raw.exists(checkpointPath("backup"))).toBe(false);
    expect((await loadIndex(w.raw, "backup")).backups[0]!.type).toBe("full");
  });

  it("is cleared after normal success, failure and cancellation", async () => {
    const w = world();
    await seedVault(w.raw, 6);
    await runOk(w.engineOn(), { mode: "full" });
    expect(await w.raw.exists(checkpointPath("backup"))).toBe(false);

    let polls = 0;
    await expect(
      w.engineOn().run({ mode: "full", isCancelled: () => ++polls > 3 }),
    ).rejects.toThrow();
    expect(await w.raw.exists(checkpointPath("backup"))).toBe(false);
  });

  it("an unreadable checkpoint is treated as none", async () => {
    const w = world();
    await seedVault(w.raw, 3);
    await w.raw.seed(checkpointPath("backup"), "{ nope");
    expect(await w.engineOn().findResumable()).toBeNull();
    expect((await w.engineOn().resume({ mode: "full" })).status).toBe("completed");
  });

  it("an encrypted backup resumes with the same salt and still verifies", async () => {
    const w = world((p) => void (p.encryption.enabled = true));
    await seedVault(w.raw, 9);
    await expect(
      w.engineOn(new DyingStore(w.raw, killOnPartWrite(2))).run({ mode: "full" }),
    ).rejects.toThrow();
    const cp = (await loadCheckpoint(w.raw, "backup"))!;

    w.clock.advance(31 * MIN);
    await runOkResume(w);

    const folder = `backup/${cp.plan.id}`;
    const salt = cp.plan.encryption.salt;
    const master = await fastMaster(fromBase64(salt));
    const key = await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
    const { manifest, files } = await readBackupFolder(w.raw, folder, key);
    expect(manifest.encryption.salt).toBe(salt);
    expect(files.size).toBe(9);
    expect(
      await verifyManifestSignature(manifest, await deriveSubKey(master, KEY_LABELS.manifestHmac)),
    ).toBe(true);
  });

  it("non-destructive resume may write to its own folder but still protects older backups", async () => {
    const w = world();
    await seedVault(w.raw, 6);
    const first = await runOk(w.engineOn(), { mode: "full", nonDestructive: true });
    w.clock.advance(MIN);
    await w.raw.seed("extra-1.md", "1");
    await w.raw.seed("extra-2.md", "2");
    await w.raw.seed("extra-3.md", "3");
    await w.raw.seed("extra-4.md", "4");
    await expect(
      w
        .engineOn(new DyingStore(w.raw, killOnPartWrite(2)))
        .run({ mode: "diff", nonDestructive: true }),
    ).rejects.toThrow();

    w.clock.advance(31 * MIN);
    const result = await w.engineOn().resume({ mode: "diff", nonDestructive: true });
    expect(result.status).toBe("completed");
    const index = await loadIndex(w.raw, "backup");
    expect(index.backups).toHaveLength(2);
    expect(index.backups[0]!.id).toBe(first.backupId);
    expect(await reconstruct(w.raw, "backup", idsOf(index))).toEqual(await liveVault(w.raw));
  });
});

async function runOkResume(w: World): Promise<void> {
  const r = await w.engineOn().resume({ mode: "full" });
  if (r.status !== "completed") throw new Error("expected completion");
}
