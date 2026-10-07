import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { fromBase64 } from "../helpers/bytes";
import { RestoreError, VerificationError } from "../helpers/errors";
import type { IVaultStore } from "../storage/VaultStore";
import type { ResolvedChain, ResolvedFile } from "./ChainResolver";
import { unpackPart } from "./Unpacker";

/** PBKDF2 master key for a salt. Wired to PassphraseService.getKey in services. */
export type MasterKeyFn = (salt: Uint8Array, iterations: number) => Promise<Uint8Array>;

/**
 * Read one file's stored version out of its backup part. Only the entry asked for is
 * decompressed, it is decrypted when the backup is encrypted, and it is checked against the
 * manifest hash, so bad data is never returned.
 */
export async function readResolvedFile(
  store: IVaultStore,
  backupFolder: string,
  chain: ResolvedChain,
  file: ResolvedFile,
  deriveMasterKey?: MasterKeyFn,
): Promise<Uint8Array> {
  const link = chain.links.find((l) => l.backup.id === file.backupId);
  if (!link) throw new RestoreError(`Backup ${file.backupId} is not part of the resolved chain`);

  let encryptionKey: CryptoKey | undefined;
  const info = link.manifest.encryption;
  if (info.enabled) {
    if (!deriveMasterKey) {
      throw new RestoreError(`Backup ${file.backupId} is encrypted and no passphrase is available`);
    }
    const master = await deriveMasterKey(fromBase64(info.salt), info.iterations);
    encryptionKey = await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
  }

  const partPath = `${backupFolder}/${file.folder}/${file.entry.part}`;
  for await (const entry of unpackPart(store, partPath, {
    encryptionKey,
    filter: (path) => path === file.path,
    expectedSha256: new Map([[file.path, file.entry.sha256]]),
  })) {
    return entry.data;
  }
  throw new VerificationError(`Backup part ${partPath} does not contain ${file.path}`);
}
