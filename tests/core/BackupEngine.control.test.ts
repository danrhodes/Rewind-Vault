import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadState } from "../../src/core/BackupState";
import type { RunProgress } from "../../src/core/RunTypes";
import { CancelledError } from "../../src/helpers/errors";
import { enc, rig, runOk, seedVault, type Rig } from "../support/engineRig";

/** Everything observable about a backup folder, to prove a cancelled run left no trace. */
async function fingerprint(r: Rig): Promise<string> {
  const names: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    const l = await r.store.list(folder);
    for (const f of l.files) names.push(`${f}:${(await r.store.stat(f))?.size}`);
    for (const d of l.folders) {
      names.push(d);
      await walk(d);
    }
  };
  if (await r.store.exists("backup")) await walk("backup");
  return names.sort().join("|");
}

describe("progress reporting", () => {
  it("reports phases in order with totals and monotonic counters", async () => {
    const r = rig((p) => void (p.zip.maxFilesPerZip = 4));
    await seedVault(r.store, 10);
    const events: RunProgress[] = [];
    await runOk(r.engine, { mode: "full", onProgress: (p) => events.push(p) });

    expect(events[0]!.phase).toBe("scanning");
    const phases = events.map((e) => e.phase);
    expect(phases.indexOf("packing")).toBeGreaterThan(phases.indexOf("scanning"));
    // Auto-verify (default L2) runs after finalizing and is the last phase.
    expect(phases.lastIndexOf("verifying")).toBe(phases.length - 1);
    expect(phases.lastIndexOf("finalizing")).toBeLessThan(phases.indexOf("verifying"));

    const packing = events.filter((e) => e.phase === "packing");
    expect(packing.every((e) => e.filesTotal === 10 && e.partCount === 3)).toBe(true);
    expect(new Set(packing.map((e) => e.partIndex))).toEqual(new Set([1, 2, 3]));
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.filesDone).toBeGreaterThanOrEqual(events[i - 1]!.filesDone);
      expect(events[i]!.bytesDone).toBeGreaterThanOrEqual(events[i - 1]!.bytesDone);
    }
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ filesDone: 10, filesTotal: 10 });
    expect(last.bytesDone).toBe(last.bytesTotal);
  });

  it("names the file being processed", async () => {
    const r = rig();
    await r.store.seed("only.md", "x");
    const seen: (string | undefined)[] = [];
    await runOk(r.engine, { mode: "full", onProgress: (p) => seen.push(p.currentFile) });
    expect(seen).toContain("only.md");
  });

  it("a throwing progress listener does not break the backup", async () => {
    const r = rig();
    await r.store.seed("a.md", "x");
    const result = await runOk(r.engine, {
      mode: "full",
      onProgress: () => {
        throw new Error("ui exploded");
      },
    });
    expect(result.fileCount).toBe(1);
  });
});

describe("cancellation", () => {
  it("cancelling before the run starts creates nothing", async () => {
    const r = rig();
    await seedVault(r.store, 5);
    await expect(r.engine.run({ mode: "full", isCancelled: () => true })).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect((await loadIndex(r.store, "backup")).backups).toEqual([]);
    expect((await r.store.list("backup")).folders).toEqual([]);
    expect(await r.store.exists("backup/lock.json")).toBe(false);
  });

  it("cancel at EVERY poll point leaves no partial backup, no state change, no lock", async () => {
    const r = rig((p) => void (p.zip.maxFilesPerZip = 3));
    await seedVault(r.store, 10);
    const first = await runOk(r.engine, { mode: "full" });
    r.clock.advance(1000);
    await r.store.writeBinary("folder0/sub0/note-0.md", enc("changed"));
    r.clock.advance(1000);

    const before = await fingerprint(r);
    const stateBefore = JSON.stringify(await loadState(r.store, "backup"));

    let completedAt = -1;
    for (let cancelAfter = 1; cancelAfter <= 200 && completedAt < 0; cancelAfter++) {
      let polls = 0;
      try {
        await r.engine.run({ mode: "full", isCancelled: () => ++polls >= cancelAfter });
        completedAt = cancelAfter;
      } catch (e) {
        expect(e).toBeInstanceOf(CancelledError);
        expect(await fingerprint(r), `cancel point ${cancelAfter}`).toBe(before);
        expect(JSON.stringify(await loadState(r.store, "backup"))).toBe(stateBefore);
        const index = await loadIndex(r.store, "backup");
        expect(index.backups.map((b) => b.id)).toEqual([first.backupId]);
        expect(await r.store.exists("backup/lock.json")).toBe(false);
      }
    }
    expect(completedAt).toBeGreaterThan(5); // there really were many cancel points to try
  });

  it("a cancelled run can be followed by a normal run that succeeds", async () => {
    const r = rig();
    await seedVault(r.store, 5);
    let polls = 0;
    await expect(
      r.engine.run({ mode: "full", isCancelled: () => ++polls > 2 }),
    ).rejects.toBeInstanceOf(CancelledError);
    const ok = await runOk(r.engine, { mode: "full" });
    expect(ok.fileCount).toBe(5);
    expect((await loadIndex(r.store, "backup")).backups).toHaveLength(1);
  });

  it("cancellation after the commit point is ignored: the finished backup stays valid", async () => {
    const r = rig();
    await r.store.seed("a.md", "x");
    const original = r.store.writeBinary.bind(r.store);
    let cancel = false;
    r.store.writeBinary = async (path, data) => {
      await original(path, data);
      if (path.endsWith("manifest.json.tmp")) cancel = true; // flips as the manifest is committed
    };
    const result = await runOk(r.engine, { mode: "full", isCancelled: () => cancel });
    expect(result.status).toBe("completed");
    expect((await loadIndex(r.store, "backup")).backups).toHaveLength(1);
  });
});

describe("commit ordering under failure", () => {
  it("if saving state fails the index is rolled back and the new folder removed", async () => {
    const r = rig();
    await r.store.seed("a.md", "x");
    const first = await runOk(r.engine, { mode: "full" });
    r.clock.advance(1000);
    await r.store.seed("b.md", "y");

    const write = r.store.writeBinary.bind(r.store);
    r.store.writeBinary = async (path, data) => {
      if (path === "backup/state.json.tmp") throw new Error("state write failed");
      return write(path, data);
    };
    await expect(r.engine.run({ mode: "full" })).rejects.toThrow("state write failed");
    r.store.writeBinary = write;

    expect((await loadIndex(r.store, "backup")).backups.map((b) => b.id)).toEqual([first.backupId]);
    expect((await r.store.list("backup")).folders).toEqual([`backup/${first.backupId}`]);
    expect(Object.keys((await loadState(r.store, "backup")).files)).toEqual(["a.md"]);
  });
});
