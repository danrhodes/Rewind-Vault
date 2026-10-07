import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { fromBase64 } from "../helpers/bytes";
import { RestoreError, VerificationError } from "../helpers/errors";
import type { IVaultStore } from "../storage/VaultStore";
import type { ResolvedChain, ResolvedFile } from "./ChainResolver";
import { unpackPart } from "./Unpacker";

/** PBKDF2 master key for a salt. Wired to PassphraseService.getKey in services. */
export type MasterKeyFn = (salt: Uint8Array, iterations: number) => Promise<Uint8Array>;

async function keyFor(
  chain: ResolvedChain,
  backupId: string,
  deriveMasterKey?: MasterKeyFn,
): Promise<CryptoKey | undefined> {
  const link = chain.links.find((l) => l.backup.id === backupId);
  if (!link) throw new RestoreError(`Backup ${backupId} is not part of the resolved chain`);
  const info = link.manifest.encryption;
  if (!info.enabled) return undefined;
  if (!deriveMasterKey) {
    throw new RestoreError(`Backup ${backupId} is encrypted and no passphrase is available`);
  }
  const master = await deriveMasterKey(fromBase64(info.salt), info.iterations);
  return importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
}

/**
 * Read stored versions out of ONE part file (all `files` must come from the same part of the
 * same backup). Each entry is decompressed one at a time, decrypted when the backup is
 * encrypted and checked against the manifest hash, so bad data is never yielded.
 */
export async function* readFilesFromPart(
  store: IVaultStore,
  backupFolder: string,
  chain: ResolvedChain,
  files: ResolvedFile[],
  deriveMasterKey?: MasterKeyFn,
): AsyncGenerator<{ file: ResolvedFile; data: Uint8Array }> {
  const first = files[0];
  if (!first) return;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const partPath = `${backupFolder}/${first.folder}/${first.entry.part}`;
  const encryptionKey = await keyFor(chain, first.backupId, deriveMasterKey);
  for await (const entry of unpackPart(store, partPath, {
    encryptionKey,
    filter: (path) => byPath.has(path),
    expectedSha256: new Map(files.map((f) => [f.path, f.entry.sha256])),
  })) {
    yield { file: byPath.get(entry.path) as ResolvedFile, data: entry.data };
  }
}

/** Read one file's stored version (see readFilesFromPart). */
export async function readResolvedFile(
  store: IVaultStore,
  backupFolder: string,
  chain: ResolvedChain,
  file: ResolvedFile,
  deriveMasterKey?: MasterKeyFn,
): Promise<Uint8Array> {
  for await (const { data } of readFilesFromPart(
    store,
    backupFolder,
    chain,
    [file],
    deriveMasterKey,
  )) {
    return data;
  }
  throw new VerificationError(
    `Backup ${file.backupId} part ${file.entry.part} does not contain ${file.path}`,
  );
}
