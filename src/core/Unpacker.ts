import { Unzip, UnzipInflate, UnzipPassThrough, inflateSync } from "fflate";
import { decrypt } from "../crypto/cipher";
import { sha256Hex } from "../crypto/hash";
import { concatBytes } from "../helpers/bytes";
import { RewindError, VerificationError } from "../helpers/errors";
import { isSafeRelPath } from "../helpers/validate";
import type { IVaultStore } from "../storage/VaultStore";

export interface UnpackedEntry {
  path: string;
  data: Uint8Array;
}

export interface UnpackOptions {
  /** Required for parts of an encrypted backup. */
  encryptionKey?: CryptoKey;
  /** Entries for which this returns false are skipped without being decompressed. */
  filter?: (path: string) => boolean;
  /**
   * Expected SHA-256 (hex) by path, normally from the manifest. Listed entries are checked
   * and a mismatch throws, so corrupt data is never handed to the caller.
   */
  expectedSha256?: ReadonlyMap<string, string>;
  /** Bytes fed to the ZIP reader at a time. Bounds how much of an entry is buffered per step. */
  readChunkBytes?: number;
}

const DEFAULT_READ_CHUNK = 256 * 1024;

interface RawEntry {
  path: string;
  raw: Uint8Array;
}

/**
 * Read one part file and yield its entries one at a time. Only the entry being decoded is
 * held in memory besides the part itself. Names are checked for path traversal, encrypted
 * entries are decrypted then inflated, and manifest hashes are verified when supplied.
 */
export async function* unpackPart(
  store: IVaultStore,
  partPath: string,
  options: UnpackOptions = {},
): AsyncGenerator<UnpackedEntry> {
  const data = await store.readBinary(partPath);
  const readChunk = options.readChunkBytes ?? DEFAULT_READ_CHUNK;

  const ready: RawEntry[] = [];
  let failure: unknown = null;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    if (!isSafeRelPath(file.name)) {
      failure = new VerificationError(
        `Backup part ${partPath} contains an unsafe path: ${file.name}`,
      );
      return;
    }
    if (options.filter && !options.filter(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) {
        failure = err;
        return;
      }
      chunks.push(chunk);
      if (final) ready.push({ path: file.name, raw: concatBytes(chunks) });
    };
    try {
      file.start();
    } catch (error) {
      failure = error;
    }
  };

  try {
    for (let offset = 0; ; offset += readChunk) {
      const last = offset + readChunk >= data.length;
      unzip.push(data.subarray(offset, Math.min(offset + readChunk, data.length)), last);
      if (failure) throw failure;
      while (ready.length > 0) yield await finish(ready.shift() as RawEntry, partPath, options);
      if (last) break;
    }
  } catch (error) {
    // Our own typed errors (wrong key, hash mismatch, unsafe path) pass through unchanged.
    if (error instanceof RewindError) throw error;
    throw new VerificationError(`Backup part ${partPath} is damaged and cannot be read`, {
      cause: error,
    });
  }
}

async function finish(
  entry: RawEntry,
  partPath: string,
  options: UnpackOptions,
): Promise<UnpackedEntry> {
  let data = entry.raw;
  if (options.encryptionKey) {
    data = inflateSync(await decrypt(options.encryptionKey, entry.raw));
  }
  const expected = options.expectedSha256?.get(entry.path);
  if (expected !== undefined && sha256Hex(data) !== expected) {
    throw new VerificationError(
      `Backup part ${partPath}: content of ${entry.path} does not match its recorded hash`,
    );
  }
  return { path: entry.path, data };
}

/** Convenience for small parts and tests: all entries of one part as a map. */
export async function unpackAll(
  store: IVaultStore,
  partPath: string,
  options: UnpackOptions = {},
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for await (const e of unpackPart(store, partPath, options)) out.set(e.path, e.data);
  return out;
}
