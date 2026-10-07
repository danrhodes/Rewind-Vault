import { describe, expect, it } from "vitest";
import { BackupEngine } from "../../src/core/BackupEngine";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadState } from "../../src/core/BackupState";
import { InsufficientSpaceError } from "../../src/helpers/errors";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { IFreeSpaceProbe } from "../../src/storage/FreeSpace";
import { MockClock } from "../mocks/MockClock";
import { MockLogger } from "../mocks/MockLogger";
import { MockVaultStore } from "../mocks/MockVaultStore";
import { fastMaster, seedVault } from "../support/engineRig";

const MB = 1024 * 1024;

function setup(freeBytes: number | null, level = 0, reserveMb = 200) {
  const clock = new MockClock();
  const store = new MockVaultStore(clock);
  const profile = createDefaultProfile("desktop");
  profile.zip.compressionLevel = level;
  profile.conditions.minFreeSpaceMb = reserveMb;
  const logger = new MockLogger();
  let probes = 0;
  const freeSpace: IFreeSpaceProbe = {
    getFreeBytes: async () => {
      probes++;
      return freeBytes;
    },
  };
  const engine = new BackupEngine({
    store,
    logger,
    clock,
    getProfile: () => profile,
    platform: "desktop",
    pluginVersion: "0.0.1",
    deriveMasterKey: fastMaster,
    yieldIfNeeded: async () => undefined,
    lockOptions: { sleep: async () => undefined },
    freeSpace,
  });
  return { store, engine, logger, probes: () => probes };
}

describe("pre-run free-space check", () => {
  it("blocks the run when free space is below the estimate plus the reserve, writing nothing", async () => {
    const t = setup(100 * MB, 0, 200);
    await seedVault(t.store, 10);
    const err = await t.engine.run({ mode: "full" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientSpaceError);
    expect((err as InsufficientSpaceError).availableBytes).toBe(100 * MB);
    expect((err as InsufficientSpaceError).requiredBytes).toBeGreaterThanOrEqual(200 * MB);

    expect((await t.store.list("backup")).folders).toEqual([]);
    expect((await loadIndex(t.store, "backup")).backups).toEqual([]);
    expect((await loadState(t.store, "backup")).updatedAt).toBe(0);
    expect(await t.store.exists("backup/lock.json")).toBe(false);
    expect(t.logger.messages("error").join()).toContain("Not enough free space");
  });

  it("boundary: exactly enough passes, one byte less is blocked", async () => {
    // 10 uncompressed files; estimate is their total size.
    const probeSize = setup(0);
    await seedVault(probeSize.store, 10);
    const files = (await probeSize.store.list("folder0/sub0")).files; // sanity: vault exists
    expect(files.length).toBeGreaterThan(0);

    let total = 0;
    const walk = async (s: MockVaultStore, f: string): Promise<void> => {
      const l = await s.list(f);
      for (const p of l.files) total += (await s.stat(p))!.size;
      for (const d of l.folders) await walk(s, d);
    };
    await walk(probeSize.store, "");

    const ok = setup(total + 0 * MB, 0, 0);
    await seedVault(ok.store, 10);
    expect((await ok.engine.run({ mode: "full" })).status).toBe("completed");

    const tight = setup(total - 1, 0, 0);
    await seedVault(tight.store, 10);
    await expect(tight.engine.run({ mode: "full" })).rejects.toBeInstanceOf(InsufficientSpaceError);
  });

  it("compression makes the estimate smaller than the raw size", async () => {
    const raw = setup(null);
    await seedVault(raw.store, 10);
    let total = 0;
    const walk = async (f: string): Promise<void> => {
      const l = await raw.store.list(f);
      for (const p of l.files) total += (await raw.store.stat(p))!.size;
      for (const d of l.folders) await walk(d);
    };
    await walk("");
    const free = Math.floor(total * 0.7);
    const compressed = setup(free, 6, 0);
    await seedVault(compressed.store, 10);
    expect((await compressed.engine.run({ mode: "full" })).status).toBe("completed");
    const stored = setup(free, 0, 0);
    await seedVault(stored.store, 10);
    await expect(stored.engine.run({ mode: "full" })).rejects.toBeInstanceOf(
      InsufficientSpaceError,
    );
  });

  it("proceeds when the platform cannot report free space", async () => {
    const t = setup(null);
    await seedVault(t.store, 3);
    expect((await t.engine.run({ mode: "full" })).status).toBe("completed");
    expect(t.probes()).toBe(1);
    expect(t.logger.messages("debug").join()).toContain("Free space unknown");
  });

  it("is not consulted when no probe is configured", async () => {
    const clock = new MockClock();
    const store = new MockVaultStore(clock);
    const engine = new BackupEngine({
      store,
      logger: new MockLogger(),
      clock,
      getProfile: () => createDefaultProfile("desktop"),
      platform: "desktop",
      pluginVersion: "0.0.1",
      deriveMasterKey: fastMaster,
      yieldIfNeeded: async () => undefined,
      lockOptions: { sleep: async () => undefined },
    });
    await seedVault(store, 2);
    expect((await engine.run({ mode: "full" })).status).toBe("completed");
  });
});
