import { describe, expect, it } from "vitest";
import { CancelledError, VerificationError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, rig, runOk, seedVault, verifyEngineFor, type Rig } from "../support/engineRig";

const SECOND = 1000;
const L1 = { level: 1 } as const;

async function oneBackup(
  tweak?: Parameters<typeof rig>[0],
  files = 12,
): Promise<{ r: Rig; id: string; folder: string }> {
  const r = rig(tweak);
  await seedVault(r.store, files);
  await r.store.seed("näme ✓.md", "unicode name");
  r.clock.advance(SECOND);
  const { backupId: id } = await runOk(r.engine, { mode: "full" });
  return { r, id, folder: `backup/${id}` };
}

const messages = (issues: { message: string }[]): string =>
  issues.map((i) => i.message).join(" | ");

describe("verify L1: healthy backups pass", () => {
  it("a full backup", async () => {
    const { r, id } = await oneBackup();
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report).toMatchObject({ backupId: id, level: 1, result: "pass", entriesChecked: 13 });
    expect(report.issues).toEqual([]);
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
  });

  it("a multi-part backup, counting every entry", async () => {
    const { r, id } = await oneBackup((p) => void (p.zip.maxFilesPerZip = 4), 30);
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report.result).toBe("pass");
    expect(report.entriesChecked).toBe(31);
  });

  it("a differential backup with tombstones, and an encrypted backup", async () => {
    const { r, id } = await oneBackup();
    await r.store.writeBinary("folder1/sub1/note-1.md", enc("changed"));
    await r.store.remove("folder2/sub2/note-2.md");
    r.clock.advance(SECOND);
    const diff = await runOk(r.engine, { mode: "diff" });
    expect(await verifyEngineFor(r).verify(diff.backupId, L1)).toMatchObject({
      result: "pass",
      entriesChecked: 1,
    });
    expect((await verifyEngineFor(r).verify(id, L1)).result).toBe("pass");

    const e = await oneBackup((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    expect((await verifyEngineFor(e.r).verify(e.id, L1)).result).toBe("pass");
  });

  it("is read-only: nothing in the backup folder changes", async () => {
    const { r, id, folder } = await oneBackup();
    const names = (await r.store.list(folder)).files.sort();
    const before = await Promise.all(names.map((n) => r.store.readBinary(n)));
    await verifyEngineFor(r).verify(id, L1);
    expect((await r.store.list(folder)).files.sort()).toEqual(names);
    expect(await Promise.all(names.map((n) => r.store.readBinary(n)))).toEqual(before);
    expect(r.logger.entries.some((e) => e.level === "warn" || e.level === "error")).toBe(false);
  });
});

describe("verify L1: damage is detected", () => {
  const part = (folder: string): string => `${folder}/part-001.zip`;

  it("corrupt header: end record signature destroyed", async () => {
    const { r, id, folder } = await oneBackup();
    const bytes = (await r.store.readBinary(part(folder))).slice();
    bytes[bytes.length - 22] = 0;
    await r.store.writeBinary(part(folder), bytes);
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report.result).toBe("fail");
    expect(report.issues[0]).toMatchObject({ part: "part-001.zip" });
    expect(messages(report.issues)).toMatch(/end-of-directory/);
  });

  it("corrupt header: first local header destroyed", async () => {
    const { r, id, folder } = await oneBackup();
    const bytes = (await r.store.readBinary(part(folder))).slice();
    bytes[0] = 0;
    await r.store.writeBinary(part(folder), bytes);
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report.result).toBe("fail");
    expect(messages(report.issues)).toMatch(/local header/);
  });

  it("truncated part: size mismatch and unreadable directory are both reported", async () => {
    const { r, id, folder } = await oneBackup();
    const bytes = await r.store.readBinary(part(folder));
    await r.store.writeBinary(part(folder), bytes.slice(0, bytes.length - 40));
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report.result).toBe("fail");
    expect(messages(report.issues)).toMatch(/manifest records/);
    expect(messages(report.issues)).toMatch(/end-of-directory|central directory/);
  });

  it("missing part file", async () => {
    const { r, id, folder } = await oneBackup();
    await r.store.remove(part(folder));
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report).toMatchObject({ result: "fail", entriesChecked: 0 });
    expect(report.issues).toEqual([{ part: "part-001.zip", message: "Part file is missing" }]);
  });

  it("a different, valid part swapped in: entries disagree with the manifest", async () => {
    const a = await oneBackup(undefined, 5);
    r_advance(a.r);
    await a.r.store.seed("only-in-second.md", "x");
    const second = await runOk(a.r.engine, { mode: "full" });
    await a.r.store.writeBinary(
      part(a.folder),
      await a.r.store.readBinary(part(`backup/${second.backupId}`)),
    );
    const report = await verifyEngineFor(a.r).verify(a.id, L1);
    expect(report.result).toBe("fail");
    expect(messages(report.issues)).toMatch(/not in the manifest/);
    expect(messages(report.issues)).toMatch(/manifest records/);
  });

  it("manifest missing, unparseable, or belonging to another backup", async () => {
    const { r, id, folder } = await oneBackup();
    const original = await readText(r.store, `${folder}/manifest.json`);
    const eng = verifyEngineFor(r);

    await r.store.writeBinary(`${folder}/manifest.json`, enc("{ not json"));
    expect(messages((await eng.verify(id, L1)).issues)).toMatch(/Manifest cannot be read/);

    await r.store.remove(`${folder}/manifest.json`);
    const missing = await eng.verify(id, L1);
    expect(missing).toMatchObject({ result: "fail", entriesChecked: 0 });

    const other = original.replace(id, "2020-01-01T00-00-00_full");
    await r.store.writeBinary(`${folder}/manifest.json`, enc(other));
    expect(messages((await eng.verify(id, L1)).issues)).toMatch(/does not match the backup index/);
  });

  it("reports every problem, across parts, not just the first", async () => {
    const { r, id, folder } = await oneBackup((p) => void (p.zip.maxFilesPerZip = 5), 14);
    await r.store.remove(`${folder}/part-001.zip`);
    const bytes = (await r.store.readBinary(`${folder}/part-002.zip`)).slice();
    bytes[bytes.length - 22] = 0;
    await r.store.writeBinary(`${folder}/part-002.zip`, bytes);
    const report = await verifyEngineFor(r).verify(id, L1);
    expect(report.issues.map((i) => i.part)).toEqual(["part-001.zip", "part-002.zip"]);
    expect(report.entriesChecked).toBe(5); // part-003 only
  });
});

function r_advance(r: Rig): void {
  r.clock.advance(5 * SECOND);
}

describe("verify: options and errors", () => {
  it("reports progress per part", async () => {
    const { r, id } = await oneBackup((p) => void (p.zip.maxFilesPerZip = 5), 14);
    const seen: [number, number][] = [];
    await verifyEngineFor(r).verify(id, {
      level: 1,
      onProgress: (p) => seen.push([p.partIndex, p.partCount]),
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("cancel stops with CancelledError", async () => {
    const { r, id } = await oneBackup();
    await expect(
      verifyEngineFor(r).verify(id, { level: 1, isCancelled: () => true }),
    ).rejects.toThrow(CancelledError);
  });

  it("rejects an unknown backup id and levels that do not exist yet", async () => {
    const { r, id } = await oneBackup();
    await expect(verifyEngineFor(r).verify("nope", L1)).rejects.toThrow(VerificationError);
    await expect(verifyEngineFor(r).verify(id, { level: 6 })).rejects.toThrow(/not available/);
  });
});
