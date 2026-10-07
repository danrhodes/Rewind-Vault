import { describe, expect, it } from "vitest";
import { crc32 } from "../../src/helpers/crc32";
import { readZipDirectory } from "../../src/helpers/zipDirectory";
import { rig, runOk, seedVault, verifyEngineFor, type Rig } from "../support/engineRig";

const L1 = { level: 1 } as const;
const L2 = { level: 2 } as const;

describe("crc32", () => {
  it("matches the published check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("is unsigned and sensitive to every byte", () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 13) % 256);
    const base = crc32(data);
    expect(base).toBeGreaterThanOrEqual(0);
    for (const i of [0, 1, 150, 299]) {
      const copy = data.slice();
      copy[i] = (copy[i] ?? 0) ^ 1;
      expect(crc32(copy)).not.toBe(base);
    }
  });

  it("agrees with the CRC the ZIP writer recorded for real backup entries", async () => {
    const r = rig();
    await seedVault(r.store, 25);
    const { backupId } = await runOk(r.engine, { mode: "full" });
    const part = await r.store.readBinary(`backup/${backupId}/part-001.zip`);
    for (const e of readZipDirectory(part)) {
      const raw = part.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
      if (e.method === 0) expect(crc32(raw)).toBe(e.crc32);
    }
  });
});

async function backup(
  tweak?: Parameters<typeof rig>[0],
  files = 12,
): Promise<{ r: Rig; id: string; part: string }> {
  const r = rig(tweak);
  await seedVault(r.store, files);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  return { r, id: backupId, part: `backup/${backupId}/part-001.zip` };
}

/** Flip one bit inside the stored data of the entry at `index` of the part. */
async function flipInEntry(r: Rig, part: string, index: number): Promise<string> {
  const bytes = (await r.store.readBinary(part)).slice();
  const entry = readZipDirectory(bytes)[index];
  if (!entry) throw new Error("no such entry");
  const at = entry.dataOffset + Math.floor(entry.compressedSize / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  await r.store.writeBinary(part, bytes);
  return entry.name;
}

describe("verify L2: healthy backups pass", () => {
  it("compressed, uncompressed, multi-part, differential and encrypted", async () => {
    for (const tweak of [
      undefined,
      (p: Parameters<NonNullable<Parameters<typeof rig>[0]>>[0]) =>
        void (p.zip.compressionLevel = 0),
      (p: Parameters<NonNullable<Parameters<typeof rig>[0]>>[0]) => void (p.zip.maxFilesPerZip = 4),
      (p: Parameters<NonNullable<Parameters<typeof rig>[0]>>[0]) => {
        p.encryption.enabled = true;
        p.encryption.kdfIterations = 600_000;
      },
    ]) {
      const { r, id } = await backup(tweak, 20);
      expect(await verifyEngineFor(r).verify(id, L2)).toMatchObject({
        result: "pass",
        level: 2,
        issues: [],
      });
    }
  });
});

describe("verify L2: flipped byte is detected and attributed", () => {
  it("compressed entry: found at L2, invisible at L1", async () => {
    const { r, id, part } = await backup();
    const victim = await flipInEntry(r, part, 3);
    expect((await verifyEngineFor(r).verify(id, L1)).result).toBe("pass");
    const report = await verifyEngineFor(r).verify(id, L2);
    expect(report.result).toBe("fail");
    expect(report.issues.some((i) => i.path === victim)).toBe(true);
    expect(report.issues.some((i) => /SHA-256/.test(i.message))).toBe(true);
  });

  it("uncompressed entry: the CRC check names exactly the damaged entry", async () => {
    const { r, id, part } = await backup((p) => void (p.zip.compressionLevel = 0));
    const victim = await flipInEntry(r, part, 5);
    const report = await verifyEngineFor(r).verify(id, L2);
    const entryIssues = report.issues.filter((i) => i.path !== undefined);
    expect(entryIssues).toEqual([
      { part: "part-001.zip", path: victim, message: "Entry fails its CRC-32 check" },
    ]);
  });

  it("encrypted entry", async () => {
    const { r, id, part } = await backup((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    const victim = await flipInEntry(r, part, 2);
    const report = await verifyEngineFor(r).verify(id, L2);
    expect(report.result).toBe("fail");
    expect(report.issues.some((i) => i.path === victim && /CRC/.test(i.message))).toBe(true);
  });

  it("a damaged CRC field in the ZIP directory", async () => {
    const { r, id, part } = await backup((p) => void (p.zip.compressionLevel = 0));
    const bytes = (await r.store.readBinary(part)).slice();
    const view = new DataView(bytes.buffer);
    const cd = view.getUint32(bytes.length - 6, true);
    view.setUint32(cd + 16, view.getUint32(cd + 16, true) ^ 0xff, true);
    await r.store.writeBinary(part, bytes);
    const report = await verifyEngineFor(r).verify(id, L2);
    expect(report.issues.some((i) => /CRC-32/.test(i.message))).toBe(true);
  });

  it("damage in two different parts is reported for both", async () => {
    const { r, id, part } = await backup((p) => void (p.zip.maxFilesPerZip = 5), 14);
    await flipInEntry(r, part, 0);
    await flipInEntry(r, part.replace("001", "003"), 0);
    const report = await verifyEngineFor(r).verify(id, L2);
    expect(new Set(report.issues.map((i) => i.part))).toEqual(
      new Set(["part-001.zip", "part-003.zip"]),
    );
  });

  it("cancel during the CRC pass stops with CancelledError", async () => {
    const { r, id } = await backup();
    let polls = 0;
    await expect(
      verifyEngineFor(r).verify(id, { level: 2, isCancelled: () => ++polls > 3 }),
    ).rejects.toThrow(/cancelled/);
  });
});
