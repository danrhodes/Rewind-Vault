import { inflateSync, unzipSync } from "fflate";
import { decrypt } from "../../src/crypto/cipher";
import { parseManifest } from "../../src/core/Manifest";
import { recoverAtomic } from "../../src/storage/AtomicWriter";
import { readText, type IVaultStore } from "../../src/storage/VaultStore";
import type { Manifest } from "../../src/types";

export interface BackupContents {
  manifest: Manifest;
  /** path -> bytes, for every entry stored in this one backup folder. */
  files: Map<string, Uint8Array>;
}

/**
 * Independent reader used by tests to check what the engine wrote: standard unzip, then
 * decrypt and inflate when the backup is encrypted. Does not use any engine code.
 */
export async function readBackupFolder(
  store: IVaultStore,
  folderPath: string,
  key?: CryptoKey,
): Promise<BackupContents> {
  // Startup repair a real consumer gets from loadManifest: a kill while the manifest was
  // being rewritten can leave it missing next to a .bak.
  await recoverAtomic(store, `${folderPath}/manifest.json`);
  const manifest = parseManifest(await readText(store, `${folderPath}/manifest.json`));
  const files = new Map<string, Uint8Array>();
  for (const part of manifest.parts) {
    const zipped = unzipSync(await store.readBinary(`${folderPath}/${part.name}`));
    for (const [path, data] of Object.entries(zipped)) {
      if (manifest.encryption.enabled) {
        if (!key) throw new Error("encrypted backup needs a key");
        files.set(path, inflateSync(await decrypt(key, data)));
      } else {
        files.set(path, data);
      }
    }
  }
  return { manifest, files };
}
