import { describe, expect, it } from "vitest";
import { KEY_LABELS, deriveSubKey, keyCheckValue } from "../../src/crypto/kdf";
import { signManifest } from "../../src/crypto/sign";
import { fromBase64 } from "../../src/helpers/bytes";
import { WrongPassphraseError } from "../../src/helpers/errors";
import { loadManifest, saveManifest } from "../../src/core/Manifest";
import { RestoreEngine } from "../../src/core/RestoreEngine";
import {
  enc,
  fastMaster,
  restoreEngineFor,
  rig,
  runOk,
  seedVault,
  verifyEngineFor,
  type Rig,
} from "../support/engineRig";

const L4 = { level: 4 } as const;
type Tweak = Parameters<typeof rig>[0];
const encrypted: Tweak = (p) => {
  p.encryption.enabled = true;
  p.encryption.kdfIterations = 600_000;
};
const wrongKey = async (salt: Uint8Array): Promise<Uint8Array> =>
  fastMaster(new Uint8Array([...salt, 7]));

async function backup(tweak?: Tweak): Promise<{ r: Rig; id: string; folder: string }> {
  const r = rig(tweak);
  await seedVault(r.store, 8);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  return { r, id: backupId, folder: `backup/${backupId}` };
}

describe("key check value", () => {
  it("is deterministic per master key, differs between keys, and is not the encryption key", async () => {
    const a = await fastMaster(enc("salt-a"));
    const b = await fastMaster(enc("salt-b"));
    expect(await keyCheckValue(a)).toBe(await keyCheckValue(a));
    expect(await keyCheckValue(a)).not.toBe(await keyCheckValue(b));
    expect(fromBase64(await keyCheckValue(a))).not.toEqual(
      await deriveSubKey(a, KEY_LABELS.encrypt),
    );
  });

  it("is stored in the manifest of encrypted backups only", async () => {
    const e = await backup(encrypted);
    const m = await loadManifest(e.r.store, e.folder);
    expect(m.encryption.keyCheck).toBe(
      await keyCheckValue(await fastMaster(fromBase64(m.encryption.salt))),
    );
    const p = await backup();
    expect((await loadManifest(p.r.store, p.folder)).encryption.keyCheck).toBeUndefined();
  });
});

describe("verify L4: encrypted backups", () => {
  it("passes with the right passphrase: decrypts everything and the signature holds", async () => {
    const { r, id } = await backup(encrypted);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L4);
    expect(report).toMatchObject({ level: 4, result: "pass", issues: [] });
    expect(report.skipped).toBeUndefined();
  });

  it("wrong passphrase is REPORTED as such, not thrown and not a pile of errors", async () => {
    const { r, id } = await backup(encrypted);
    const report = await verifyEngineFor(r, { deriveMasterKey: wrongKey }).verify(id, L4);
    expect(report.result).toBe("fail");
    expect(report.issues).toEqual([
      { message: "Wrong passphrase: it is not the one this backup was encrypted with" },
    ]);
  });

  it("without a passphrase source: skipped with an explanation, not a failure or a crash", async () => {
    const { r, id } = await backup(encrypted);
    const report = await verifyEngineFor(r).verify(id, L4);
    expect(report.result).toBe("pass");
    expect(report.skipped?.[0]).toMatch(/need the passphrase/);
  });

  it("detects a manifest whose content was altered after signing", async () => {
    const { r, id, folder } = await backup(encrypted);
    const m = await loadManifest(r.store, folder);
    m.pluginVersion = "9.9.9"; // covered by the signature
    await saveManifest(r.store, folder, m);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L4);
    expect(report.result).toBe("fail");
    expect(report.issues.map((i) => i.message).join()).toMatch(/signature is invalid/);
  });

  it("a status/verify change after signing does NOT break the signature (corrupt marking is legal)", async () => {
    const { r, id, folder } = await backup(encrypted);
    const m = await loadManifest(r.store, folder);
    m.status = "corrupt";
    m.verify = { lastLevel: 2, lastAt: 1, result: "fail" };
    await saveManifest(r.store, folder, m);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L4);
    expect(report.issues).toEqual([]);
  });

  it("an unsigned manifest in an encrypted backup is flagged", async () => {
    const { r, id, folder } = await backup(encrypted);
    const m = await loadManifest(r.store, folder);
    delete m.hmac;
    await saveManifest(r.store, folder, m);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L4);
    expect(report.issues.map((i) => i.message).join()).toMatch(/not signed/);
  });

  it("a re-signed manifest with a forged signature key is caught", async () => {
    const { r, id, folder } = await backup(encrypted);
    const m = await loadManifest(r.store, folder);
    m.hmac = await signManifest(m, new Uint8Array(32));
    await saveManifest(r.store, folder, m);
    const report = await verifyEngineFor(r, { deriveMasterKey: fastMaster }).verify(id, L4);
    expect(report.result).toBe("fail");
  });

  it("a key source that throws is noted as skipped", async () => {
    const { r, id } = await backup(encrypted);
    const report = await verifyEngineFor(r, {
      deriveMasterKey: async () => {
        throw new Error("prompt closed");
      },
    }).verify(id, L4);
    expect(report.result).toBe("pass");
    expect(report.skipped).toHaveLength(1);
  });
});

describe("verify L4: unencrypted backups", () => {
  it("passes and says the decrypt check does not apply", async () => {
    const { r, id } = await backup();
    const report = await verifyEngineFor(r).verify(id, L4);
    expect(report.result).toBe("pass");
    expect(report.skipped).toEqual(["The backup is not encrypted: decrypt check not applicable"]);
  });
});

describe("wrong passphrase on restore", () => {
  it("is a WrongPassphraseError, not a generic tamper error", async () => {
    const { r, id } = await backup(encrypted);
    const eng = new RestoreEngine({
      store: r.store,
      logger: r.logger,
      clock: r.clock,
      getProfile: () => r.profile,
      yieldIfNeeded: async () => undefined,
      deriveMasterKey: wrongKey,
    });
    await expect(eng.restoreVault({ source: { id } })).rejects.toThrow(WrongPassphraseError);
    expect(await r.store.exists(`restore/${id}`)).toBe(false);
    // and the right passphrase still works
    const ok = restoreEngineFor(r, { deriveMasterKey: fastMaster });
    expect((await ok.restoreVault({ source: { id } })).created).toBe(8);
  });
});
