import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadState } from "../../src/core/BackupState";
import { sha256Hex } from "../../src/crypto/hash";
import { LockError } from "../../src/helpers/errors";
import { rig, seedVault, runOk } from "../support/engineRig";
import { readBackupFolder } from "../support/readBackup";

describe("BackupEngine full mode", () => {
  it("backs up a 1,000-file vault and every file round-trips byte for byte", async () => {
    const { store, engine } = rig();
    const originals = await seedVault(store, 1000);

    const result = await runOk(engine, { mode: "full" });
    expect(result).toMatchObject({ status: "completed", type: "full", fileCount: 1000 });
    expect(result.backupId).toBe("2026-10-07T21-24-00_full");

    const { manifest, files } = await readBackupFolder(store, `backup/${result.backupId}`);
    expect(files.size).toBe(1000);
    for (const [path, data] of originals) expect(files.get(path)).toEqual(data);
    expect(manifest).toMatchObject({
      type: "full",
      baseId: null,
      status: "ok",
      platform: "desktop",
    });
    expect(manifest.entries).toHaveLength(1000);
    for (const e of manifest.entries)
      expect(e.sha256).toBe(sha256Hex(originals.get(e.path) as Uint8Array));
  });

  it("registers the backup, records state for every file, and cleans up", async () => {
    const { store, engine } = rig();
    await seedVault(store, 25);
    const result = await runOk(engine, { mode: "full" });

    const index = await loadIndex(store, "backup");
    expect(index.backups).toHaveLength(1);
    expect(index.backups[0]).toMatchObject({
      id: result.backupId,
      status: "ok",
      pinned: false,
      type: "full",
    });
    expect(index.backups[0]!.size).toBe(result.bytes);

    const state = await loadState(store, "backup");
    expect(Object.keys(state.files)).toHaveLength(25);

    expect(await store.exists("backup/lock.json")).toBe(false);
    const top = await store.list("backup");
    expect(top.files.sort()).toEqual(["backup/index.json", "backup/state.json"]);
    const inFolder = (await store.list(`backup/${result.backupId}`)).files;
    expect(inFolder.every((f) => !f.endsWith(".tmp") && !f.endsWith(".bak"))).toBe(true);
  });

  it("splits into several parts when limits require it, with consistent manifest records", async () => {
    const { store, engine } = rig((p) => void (p.zip.maxFilesPerZip = 100));
    const originals = await seedVault(store, 1000);
    const result = await runOk(engine, { mode: "full" });
    const { manifest, files } = await readBackupFolder(store, `backup/${result.backupId}`);
    expect(manifest.parts).toHaveLength(10);
    expect(manifest.parts.map((p) => p.name)[0]).toBe("part-001.zip");
    expect(manifest.parts.every((p) => p.entryCount === 100)).toBe(true);
    expect(files.size).toBe(originals.size);
    for (const part of manifest.parts) {
      const bytes = await store.readBinary(`backup/${result.backupId}/${part.name}`);
      expect(bytes.length).toBe(part.size);
      expect(sha256Hex(bytes)).toBe(part.sha256);
    }
  });

  it("never backs up its own backup folder, even on a second run", async () => {
    const { store, clock, engine } = rig();
    await seedVault(store, 5);
    await runOk(engine, { mode: "full" });
    clock.advance(60_000);
    const second = await runOk(engine, { mode: "full" });
    expect(second.fileCount).toBe(5);
    const { files } = await readBackupFolder(store, `backup/${second.backupId}`);
    expect([...files.keys()].some((p) => p.startsWith("backup/"))).toBe(false);
  });

  it("two runs in the same second get different folders and both survive", async () => {
    const { store, engine } = rig();
    await seedVault(store, 3);
    const a = await runOk(engine, { mode: "full" });
    const b = await runOk(engine, { mode: "full" });
    expect(a.backupId).not.toBe(b.backupId);
    expect((await loadIndex(store, "backup")).backups).toHaveLength(2);
  });

  it("backs up an empty vault as a valid empty full backup", async () => {
    const { store, engine } = rig();
    const result = await runOk(engine, { mode: "full" });
    expect(result).toMatchObject({ fileCount: 0, bytes: 0 });
    const { manifest } = await readBackupFolder(store, `backup/${result.backupId}`);
    expect(manifest.parts).toEqual([]);
    expect(manifest.status).toBe("ok");
  });

  it("honours exclusions and hidden-file settings", async () => {
    const { store, engine } = rig((p) => {
      p.exclusions.globs = ["*.tmp"];
      p.basic.includeHidden = false;
    });
    await store.seed("keep.md", "x");
    await store.seed("skip.tmp", "x");
    await store.seed(".obsidian/app.json", "{}");
    const result = await runOk(engine, { mode: "full" });
    const { files } = await readBackupFolder(store, `backup/${result.backupId}`);
    expect([...files.keys()]).toEqual(["keep.md"]);
  });

  it("reports over-max files that were left out", async () => {
    const { store, engine } = rig((p) => {
      p.zip.maxSourceMbPerZip = 1;
      p.zip.maxOutputZipMb = 1;
      p.zip.processOverMax = false;
    });
    await store.writeBinary("huge.bin", new Uint8Array(1024 * 1024 + 1));
    await store.seed("small.md", "x");
    const result = await runOk(engine, { mode: "full" });
    expect(result.skippedFiles).toEqual(["huge.bin"]);
    expect(result.fileCount).toBe(1);
  });
});

describe("BackupEngine failure handling", () => {
  it("a write failure mid-run leaves no folder, no index entry, old state, and no lock", async () => {
    const { store, engine } = rig((p) => void (p.zip.maxFilesPerZip = 5));
    await seedVault(store, 20);
    const first = await runOk(engine, { mode: "full" });
    const stateBefore = JSON.stringify(await loadState(store, "backup"));

    let partWrites = 0;
    const write = store.writeBinary.bind(store);
    store.writeBinary = async (path, data) => {
      if (path.endsWith(".zip") || path.endsWith(".zip.tmp")) {
        if (++partWrites === 3) throw new Error("disk full");
      }
      return write(path, data);
    };

    await expect(engine.run({ mode: "full" })).rejects.toThrow("disk full");
    const folders = (await store.list("backup")).folders;
    expect(folders).toEqual([`backup/${first.backupId}`]);
    expect((await loadIndex(store, "backup")).backups).toHaveLength(1);
    expect(JSON.stringify(await loadState(store, "backup"))).toBe(stateBefore);
    expect(await store.exists("backup/lock.json")).toBe(false);
  });

  it("refuses to start while another live run holds the lock, and writes nothing", async () => {
    const { store, clock, engine } = rig();
    await seedVault(store, 3);
    await store.seed(
      "backup/lock.json",
      JSON.stringify({
        ownerId: "other",
        platform: "mobile",
        acquiredAt: clock.now(),
        heartbeatAt: clock.now(),
      }),
    );
    await expect(engine.run({ mode: "full" })).rejects.toBeInstanceOf(LockError);
    expect((await store.list("backup")).folders).toEqual([]);
    expect(await store.exists("backup/lock.json")).toBe(true);
  });
});
