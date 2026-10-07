import { describe, expect, it } from "vitest";
import { importAesKey } from "../../src/crypto/cipher";
import { KEY_LABELS, deriveKeyBytes, deriveSubKey } from "../../src/crypto/kdf";
import { verifyManifestSignature } from "../../src/crypto/sign";
import { fromBase64 } from "../../src/helpers/bytes";
import { enc, fastMaster, rig, seedVault } from "../support/engineRig";
import { readBackupFolder } from "../support/readBackup";

describe("BackupEngine encryption", () => {
  it("encrypts every entry, signs the manifest and round-trips with the right key", async () => {
    const { store, engine } = rig((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    const originals = await seedVault(store, 30);
    const result = await engine.run({ mode: "full" });
    const folder = `backup/${result.backupId}`;

    const { manifest } = await readBackupFolder(store, folder, undefined).catch(async () => ({
      manifest: null,
      files: null,
    }));
    expect(manifest).toBeNull(); // cannot be read without a key

    const master = await fastMaster(
      fromBase64(
        JSON.parse(new TextDecoder().decode(await store.readBinary(`${folder}/manifest.json`)))
          .encryption.salt,
      ),
    );
    const key = await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
    const read = await readBackupFolder(store, folder, key);
    expect(read.manifest.encryption).toMatchObject({ enabled: true, iterations: 600_000 });
    expect(read.manifest.encryption.salt).not.toBe("");
    for (const [path, data] of originals) expect(read.files.get(path)).toEqual(data);
    expect(
      await verifyManifestSignature(
        read.manifest,
        await deriveSubKey(master, KEY_LABELS.manifestHmac),
      ),
    ).toBe(true);

    // Nothing readable in the stored parts.
    const part = await store.readBinary(`${folder}/part-001.zip`);
    expect(new TextDecoder().decode(part)).not.toContain("line of text");
  });

  it("works with the real PBKDF2 derivation and a salt that differs per backup", async () => {
    const { store, engine } = rig((p) => void (p.encryption.enabled = true), {
      deriveMasterKey: (salt, iterations) =>
        deriveKeyBytes("correct horse battery", salt, iterations),
    });
    await store.seed("a.md", "secret");
    const a = await engine.run({ mode: "full" });
    const b = await engine.run({ mode: "full" });
    const saltOf = async (id: string): Promise<string> =>
      JSON.parse(new TextDecoder().decode(await store.readBinary(`backup/${id}/manifest.json`)))
        .encryption.salt;
    expect(await saltOf(a.backupId)).not.toBe(await saltOf(b.backupId));

    const master = await deriveKeyBytes(
      "correct horse battery",
      fromBase64(await saltOf(a.backupId)),
    );
    const key = await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
    expect((await readBackupFolder(store, `backup/${a.backupId}`, key)).files.get("a.md")).toEqual(
      enc("secret"),
    );

    const wrong = await importAesKey(
      await deriveSubKey(
        await deriveKeyBytes("wrong", fromBase64(await saltOf(a.backupId))),
        KEY_LABELS.encrypt,
      ),
    );
    await expect(readBackupFolder(store, `backup/${a.backupId}`, wrong)).rejects.toThrow();
  });
});
