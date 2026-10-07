import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/crypto/hash";
import { CancelledError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import type { Manifest } from "../../src/types";
import {
  enc,
  fastMaster,
  rig,
  runOk,
  seedVault,
  verifyEngineFor,
  type Rig,
} from "../support/engineRig";

const L1 = { level: 1 } as const;
const L2 = { level: 2 } as const;
const L3 = { level: 3 } as const;

type Tweak = Parameters<typeof rig>[0];
const encrypted: Tweak = (p) => {
  p.encryption.enabled = true;
  p.encryption.kdfIterations = 600_000;
};

async function backup(
  tweak?: Tweak,
  files = 12,
): Promise<{ r: Rig; id: string; folder: string; part: string }> {
  const r = rig(tweak);
  await seedVault(r.store, files);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  const folder = `backup/${backupId}`;
  return { r, id: backupId, folder, part: `${folder}/part-001.zip` };
}

async function editManifest(r: Rig, folder: string, edit: (m: Manifest) => void): Promise<void> {
  const path = `${folder}/manifest.json`;
  const m = JSON.parse(await readText(r.store, path)) as Manifest;
  edit(m);
  await r.store.writeBinary(path, enc(JSON.stringify(m)));
}

/**
 * The attack a CRC cannot see: replace an entry's content with different bytes of the same
 * length, rebuild the ZIP (so every CRC is valid) and fix up the manifest's part size and hash.
 * Structure and CRC checks pass; only the per-entry SHA-256 can tell.
 */
async function tamperEntry(r: Rig, folder: string, part: string, name: string): Promise<void> {
  const files = unzipSync(await r.store.readBinary(part));
  const original = files[name];
  if (!original) throw new Error("no such entry");
  files[name] = strToU8("X".repeat(original.length));
  const rebuilt = zipSync(files);
  await r.store.writeBinary(part, rebuilt);
  await editManifest(r, folder, (m) => {
    const p = m.parts[0];
    if (p) {
      p.size = rebuilt.length;
      p.sha256 = sha256Hex(rebuilt);
    }
  });
}

describe("verify L3: healthy backups pass", () => {
  it("compressed, stored, multi-part and differential, with no skipped checks", async () => {
    for (const tweak of [
      undefined,
      (p: Parameters<NonNullable<Tweak>>[0]) => void (p.zip.compressionLevel = 0),
      (p: Parameters<NonNullable<Tweak>>[0]) => void (p.zip.maxFilesPerZip = 4),
    ]) {
      const { r, id } = await backup(tweak, 20);
      const report = await verifyEngineFor(r).verify(id, L3);
      expect(report).toMatchObject({ result: "pass", level: 3, entriesChecked: 20, issues: [] });
      expect(report.skipped).toBeUndefined();
    }
    const { r } = await backup();
    await r.store.writeBinary("folder1/sub1/note-1.md", enc("edited"));
    r.clock.advance(1000);
    const diff = await runOk(r.engine, { mode: "diff" });
    expect((await verifyEngineFor(r).verify(diff.backupId, L3)).result).toBe("pass");
  });
});

describe("verify L3: tampering is detected", () => {
  it("tampered entry with a rebuilt ZIP: invisible at L1 and L2, caught at L3 and named", async () => {
    const { r, id, folder, part } = await backup();
    const name = "folder1/sub1/note-1.md";
    await tamperEntry(r, folder, part, name);
    const eng = verifyEngineFor(r);
    expect((await eng.verify(id, L1)).result).toBe("pass");
    expect((await eng.verify(id, L2)).result).toBe("pass");
    const report = await eng.verify(id, L3);
    expect(report.result).toBe("fail");
    expect(report.issues).toEqual([
      {
        part: "part-001.zip",
        path: name,
        message: "Entry content does not match the SHA-256 in the manifest",
      },
    ]);
  });

  it("a manifest hash that was altered", async () => {
    const { r, id, folder } = await backup();
    await editManifest(r, folder, (m) => {
      const e = m.entries[4];
      if (e) e.sha256 = "0".repeat(64);
    });
    const eng = verifyEngineFor(r);
    expect((await eng.verify(id, L2)).result).toBe("pass");
    const report = await eng.verify(id, L3);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.message).toMatch(/SHA-256 in the manifest/);
  });

  it("every tampered entry is reported, not just the first", async () => {
    const { r, id, folder, part } = await backup();
    await tamperEntry(r, folder, part, "folder1/sub1/note-1.md");
    await tamperEntry(r, folder, part, "folder2/sub2/note-2.md");
    const report = await verifyEngineFor(r).verify(id, L3);
    expect(report.issues.map((i) => i.path).sort()).toEqual([
      "folder1/sub1/note-1.md",
      "folder2/sub2/note-2.md",
    ]);
  });
});

describe("verify L3: encrypted backups", () => {
  it("without a key source, stops at L2 and says what was skipped (not a failure)", async () => {
    const { r, id } = await backup(encrypted);
    const report = await verifyEngineFor(r).verify(id, L3);
    expect(report.result).toBe("pass");
    expect(report.skipped?.[0]).toMatch(/needs the passphrase/);
  });

  it("with the right key, hashes the plaintext of every entry", async () => {
    const { r, id } = await backup(encrypted);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L3);
    expect(report).toMatchObject({ result: "pass", issues: [] });
    expect(report.skipped).toBeUndefined();
  });

  it("with the right key, still catches a wrong hash in the manifest", async () => {
    const { r, id, folder } = await backup(encrypted);
    await editManifest(r, folder, (m) => {
      const e = m.entries[0];
      if (e) e.sha256 = "f".repeat(64);
    });
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L3);
    expect(report.result).toBe("fail");
    expect(report.issues[0]?.message).toMatch(/SHA-256 in the manifest/);
  });

  it("with a wrong key, reports every entry as undecryptable instead of crashing", async () => {
    const { r, id } = await backup(encrypted, 6);
    const report = await verifyEngineFor(r, {
      deriveMasterKey: async (salt) => fastMaster(new Uint8Array([...salt, 9])),
    }).verify(id, L3);
    expect(report.result).toBe("fail");
    expect(report.issues).toHaveLength(6);
    expect(report.issues[0]?.message).toMatch(/cannot be decrypted/);
  });

  it("a key source that fails is noted as skipped; a cancelled prompt cancels", async () => {
    const { r, id } = await backup(encrypted);
    const failing = await verifyEngineFor(r, {
      deriveMasterKey: async () => {
        throw new Error("no passphrase");
      },
    }).verify(id, L3);
    expect(failing.result).toBe("pass");
    expect(failing.skipped).toHaveLength(1);
    await expect(
      verifyEngineFor(r, {
        deriveMasterKey: async () => {
          throw new CancelledError();
        },
      }).verify(id, L3),
    ).rejects.toThrow(CancelledError);
  });
});
