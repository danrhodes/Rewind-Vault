import { describe, expect, it } from "vitest";
import { loadIndex, saveIndex } from "../../src/core/BackupIndex";
import { CancelledError } from "../../src/helpers/errors";
import { enc, fastMaster, rig, runOk, verifyEngineFor, type Rig } from "../support/engineRig";

const L6 = { level: 6 } as const;
const SECOND = 1000;

type Tweak = Parameters<typeof rig>[0];
const encrypted: Tweak = (p) => {
  p.encryption.enabled = true;
  p.encryption.kdfIterations = 600_000;
};

async function vault(tweak?: Tweak): Promise<{ r: Rig; id: string }> {
  const r = rig(tweak);
  for (const [p, t] of Object.entries({
    "a.md": "alpha",
    "b.md": "bravo",
    "docs/c.md": "charlie",
    "docs/d.md": "delta",
  })) {
    await r.store.seed(p, t);
  }
  r.clock.advance(10 * SECOND);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  return { r, id: backupId };
}

describe("verify L6: rehearsal restore", () => {
  it("an untouched vault: everything restores and matches the live files", async () => {
    const { r, id } = await vault();
    const report = await verifyEngineFor(r).verify(id, L6);
    expect(report).toMatchObject({ level: 6, result: "pass", issues: [] });
    expect(report.rehearsal).toEqual({
      filesRestored: 4,
      bytesRestored: "alphabravocharliedelta".length,
      matchLive: 4,
      changedSinceBackup: 0,
      missingFromLive: 0,
      notInBackup: 0,
    });
  });

  it("edits, deletions and new files since the backup are counted, not failures", async () => {
    const { r, id } = await vault();
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("a.md", enc("alpha EDITED"));
    await r.store.remove("docs/d.md");
    await r.store.seed("new1.md", "n");
    await r.store.seed("docs/new2.md", "n");
    const report = await verifyEngineFor(r).verify(id, L6);
    expect(report.result).toBe("pass");
    expect(report.rehearsal).toMatchObject({
      filesRestored: 4,
      matchLive: 2,
      changedSinceBackup: 1,
      missingFromLive: 1,
      notInBackup: 2,
    });
  });

  it("a live file with the recorded size and mtime but other content FAILS, naming it", async () => {
    const { r, id } = await vault();
    // Same length and the same modification time as when it was backed up.
    const before = await r.store.stat("b.md");
    const now = r.clock.now();
    r.clock.set(before?.mtime ?? 0);
    await r.store.writeBinary("b.md", enc("BRAVO"));
    r.clock.set(now);
    const report = await verifyEngineFor(r).verify(id, L6);
    expect(report.result).toBe("fail");
    expect(report.issues).toEqual([
      expect.objectContaining({
        path: "b.md",
        message: expect.stringContaining("different content"),
      }),
    ]);
  });

  it("a differential backup rehearses the WHOLE vault as of that backup", async () => {
    const { r } = await vault();
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("a.md", enc("alpha v2"));
    await r.store.remove("docs/c.md");
    const diff = await runOk(r.engine, { mode: "diff" });
    const report = await verifyEngineFor(r).verify(diff.backupId, L6);
    expect(report.result).toBe("pass");
    expect(report.rehearsal).toMatchObject({ filesRestored: 3, matchLive: 3, missingFromLive: 0 });
  });

  it("is read-only: nothing is written, no restore folder appears", async () => {
    const { r, id } = await vault();
    const names = async (): Promise<string[]> => [
      ...(await r.store.list("")).files,
      ...(await r.store.list("")).folders,
    ];
    const before = await names();
    await verifyEngineFor(r).verify(id, L6);
    expect(await names()).toEqual(before);
    expect(await r.store.exists("restore")).toBe(false);
  });

  it("rot inside a part is reported (the rehearsal cannot reproduce the file)", async () => {
    const { r, id } = await vault((p) => void (p.zip.compressionLevel = 0));
    const part = `backup/${id}/part-001.zip`;
    const bytes = (await r.store.readBinary(part)).slice();
    const at = new TextDecoder("latin1").decode(bytes).indexOf("charlie");
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await r.store.writeBinary(part, bytes);
    const report = await verifyEngineFor(r).verify(id, L6);
    expect(report.result).toBe("fail");
    expect(report.issues.some((i) => /Restore rehearsal failed/.test(i.message))).toBe(true);
    expect(report.issues.some((i) => /CRC-32/.test(i.message))).toBe(true); // L2 saw it too
  });

  it("an unresolvable chain is reported instead of crashing", async () => {
    const { r } = await vault();
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("a.md", enc("v2"));
    const diff = await runOk(r.engine, { mode: "diff" });
    const index = await loadIndex(r.store, "backup");
    await saveIndex(r.store, "backup", {
      ...index,
      backups: index.backups.filter((b) => b.type === "diff"),
    });
    const report = await verifyEngineFor(r).verify(diff.backupId, L6);
    expect(report.result).toBe("fail");
    expect(report.issues.some((i) => /Rehearsal cannot start/.test(i.message))).toBe(true);
    expect(report.rehearsal).toBeUndefined();
  });

  it("cancel stops with CancelledError", async () => {
    const { r, id } = await vault();
    let polls = 0;
    await expect(
      verifyEngineFor(r).verify(id, { level: 6, isCancelled: () => ++polls > 6 }),
    ).rejects.toThrow(CancelledError);
  });
});

describe("verify L6: encrypted backups", () => {
  it("rehearses with the right key", async () => {
    const { r, id } = await vault(encrypted);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L6);
    expect(report).toMatchObject({ result: "pass", issues: [] });
    expect(report.rehearsal?.matchLive).toBe(4);
  });

  it("without a passphrase source it says it was not run", async () => {
    const { r, id } = await vault(encrypted);
    const report = await verifyEngineFor(r).verify(id, L6);
    expect(report.result).toBe("pass");
    expect(report.rehearsal).toBeUndefined();
    expect(report.skipped?.some((s) => /Rehearsal.*passphrase/.test(s))).toBe(true);
  });

  it("with a wrong passphrase it fails with a wrong-passphrase finding", async () => {
    const { r, id } = await vault(encrypted);
    const report = await verifyEngineFor(r, {
      deriveMasterKey: async (salt) => fastMaster(new Uint8Array([...salt, 1])),
    }).verify(id, L6);
    expect(report.result).toBe("fail");
    expect(report.issues.map((i) => i.message).join(" | ")).toMatch(/Wrong passphrase/);
  });
});
