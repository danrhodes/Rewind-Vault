import { describe, expect, it } from "vitest";
import { loadIndex, saveIndex, updateBackup } from "../../src/core/BackupIndex";
import { loadManifest, saveManifest } from "../../src/core/Manifest";
import { CancelledError } from "../../src/helpers/errors";
import { enc, rig, runOk, verifyEngineFor, type Rig } from "../support/engineRig";

const L5 = { level: 5 } as const;
const SECOND = 1000;

/** full -> diff1 -> diff2 -> diff3, one edited file each time. */
async function chain(): Promise<{ r: Rig; ids: string[] }> {
  const r = rig();
  await r.store.seed("a.md", "a");
  await r.store.seed("b.md", "b");
  const ids: string[] = [];
  for (const mode of ["full", "diff", "diff", "diff"] as const) {
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("a.md", enc(`a at ${r.clock.now()}`));
    ids.push((await runOk(r.engine, { mode })).backupId);
  }
  return { r, ids };
}

const text = (issues: { message: string }[]): string => issues.map((i) => i.message).join(" | ");

describe("verify L5: healthy chains", () => {
  it("passes for every backup in a full + 3 diffs chain", async () => {
    const { r, ids } = await chain();
    for (const id of ids) {
      const report = await verifyEngineFor(r).verify(id, L5);
      expect(report).toMatchObject({ level: 5, result: "pass", issues: [] });
    }
  });

  it("counts entries across the whole chain", async () => {
    const { r, ids } = await chain();
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    // target (1 changed file) + diff2 (1) + diff1 (1) + full (2)
    expect(report.entriesChecked).toBe(5);
  });

  it("a full backup has no dependencies", async () => {
    const { r, ids } = await chain();
    expect((await verifyEngineFor(r).verify(ids[0] as string, L5)).entriesChecked).toBe(2);
  });

  it("ignores an older, corrupt full backup the chain does not use", async () => {
    const { r, ids } = await chain();
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("a.md", enc("newer"));
    const full2 = (await runOk(r.engine, { mode: "full" })).backupId;
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("a.md", enc("newest"));
    const diff = (await runOk(r.engine, { mode: "diff" })).backupId;
    const index = await loadIndex(r.store, "backup");
    await saveIndex(
      r.store,
      "backup",
      updateBackup(index, ids[0] as string, { status: "corrupt" }),
    );
    expect((await verifyEngineFor(r).verify(diff, L5)).result).toBe("pass");
    expect(full2).not.toBe(ids[0]);
  });
});

describe("verify L5: broken chains are detected", () => {
  it("broken-base fixture: base folder deleted", async () => {
    const { r, ids } = await chain();
    await r.store.removeFolder(`backup/${ids[0]}`);
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    expect(report.result).toBe("fail");
    expect(
      report.issues.some((i) => i.backupId === ids[0] && /manifest is missing/.test(i.message)),
    ).toBe(true);
  });

  it("base part file deleted: found through the integrity pass on the dependency", async () => {
    const { r, ids } = await chain();
    await r.store.remove(`backup/${ids[0]}/part-001.zip`);
    const report = await verifyEngineFor(r).verify(ids[2] as string, L5);
    expect(report.result).toBe("fail");
    const hit = report.issues.find((i) => /Part file is missing/.test(i.message));
    expect(hit?.backupId).toBe(ids[0]);
  });

  it("base removed from the index", async () => {
    const { r, ids } = await chain();
    const index = await loadIndex(r.store, "backup");
    await saveIndex(r.store, "backup", {
      ...index,
      backups: index.backups.filter((b) => b.id !== ids[0]),
    });
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    expect(report.result).toBe("fail");
    expect(text(report.issues)).toMatch(/missing from the index/);
  });

  it("a link marked corrupt", async () => {
    const { r, ids } = await chain();
    const index = await loadIndex(r.store, "backup");
    await saveIndex(
      r.store,
      "backup",
      updateBackup(index, ids[1] as string, { status: "corrupt" }),
    );
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    expect(report.issues.find((i) => i.backupId === ids[1])?.message).toMatch(/marked corrupt/);
  });

  it("a middle diff deleted from disk but still indexed", async () => {
    const { r, ids } = await chain();
    await r.store.removeFolder(`backup/${ids[2]}`);
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    expect(report.result).toBe("fail");
    expect(report.issues.some((i) => i.backupId === ids[2])).toBe(true);
  });

  it("a diff whose manifest names a different base", async () => {
    const { r, ids } = await chain();
    const folder = `backup/${ids[2]}`;
    const m = await loadManifest(r.store, folder);
    m.baseId = "2020-01-01T00-00-00_full";
    await saveManifest(r.store, folder, m);
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    expect(text(report.issues)).toMatch(/not on the chain base/);
  });

  it("rot inside an earlier link (flipped byte) is reported against that backup", async () => {
    const { r, ids } = await chain();
    const part = `backup/${ids[1]}/part-001.zip`;
    const bytes = (await r.store.readBinary(part)).slice();
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await r.store.writeBinary(part, bytes);
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    expect(report.result).toBe("fail");
    expect(report.issues.every((i) => i.backupId === ids[1])).toBe(true);
    // the same backup verified at L4 is fine: only the chain level looks at its ancestors
    expect((await verifyEngineFor(r).verify(ids[3] as string, { level: 4 })).result).toBe("pass");
  });

  it("every broken link is reported, not just the first", async () => {
    const { r, ids } = await chain();
    await r.store.removeFolder(`backup/${ids[0]}`);
    await r.store.removeFolder(`backup/${ids[2]}`);
    const report = await verifyEngineFor(r).verify(ids[3] as string, L5);
    const tagged = new Set(report.issues.map((i) => i.backupId));
    expect(tagged.has(ids[0])).toBe(true);
    expect(tagged.has(ids[2])).toBe(true);
  });

  it("cancel stops with CancelledError", async () => {
    const { r, ids } = await chain();
    await expect(
      verifyEngineFor(r).verify(ids[3] as string, { level: 5, isCancelled: () => true }),
    ).rejects.toThrow(CancelledError);
  });
});
