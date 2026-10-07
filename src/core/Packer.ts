import { Zip, ZipDeflate, ZipPassThrough, deflateSync, type DeflateOptions } from "fflate";
import { encrypt } from "../crypto/cipher";
import { sha256Hex } from "../crypto/hash";
import { concatBytes } from "../helpers/bytes";
import { CancelledError, ConfigError, CryptoError } from "../helpers/errors";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { FileInfo } from "../types";
import type { HashedFile } from "./Differ";

export interface PackOptions {
  /** 0 (store) to 9 (smallest). */
  compressionLevel: number;
  /** When set, every entry is deflated, then encrypted (see crypto/cipher). Names stay readable. */
  encryptionKey?: CryptoKey;
  /** Plaintext bytes per encrypted frame. */
  chunkSize?: number;
}

export interface PackedPart {
  /** The finished ZIP file. */
  data: Uint8Array;
  /** SHA-256 of `data`, for the manifest's part record. */
  sha256: string;
  /** What was stored, with size and hash taken from the bytes actually read. */
  entries: HashedFile[];
  /** Files that disappeared between the scan and the read. */
  skipped: string[];
}

/** ZIP stores dates from 1980 onwards. */
const ZIP_EPOCH_MS = Date.UTC(1980, 0, 1);

function checkLevel(level: number): DeflateOptions["level"] {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new ConfigError("Compression level must be an integer from 0 to 9");
  }
  return level as DeflateOptions["level"];
}

/**
 * Build one ZIP part from `files`. Unencrypted parts are standard ZIP files that any
 * unzip tool opens. Encrypted parts are still ZIP containers, but each entry's payload is
 * AES-GCM ciphertext of the deflated data, so only this plugin (or the README recipe) can
 * read them. The part is assembled in memory: its size is bounded by the splitter limits.
 */
export async function packPart(
  store: IVaultStore,
  files: readonly FileInfo[],
  options: PackOptions,
  yieldIfNeeded: () => Promise<void> = createYielder(),
  isCancelled: () => boolean = () => false,
  onFile: (file: FileInfo) => void = () => undefined,
): Promise<PackedPart> {
  const level = checkLevel(options.compressionLevel);
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else chunks.push(chunk);
  });

  const entries: HashedFile[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (isCancelled()) {
      zip.terminate();
      throw new CancelledError();
    }
    let data: Uint8Array;
    try {
      data = await store.readBinary(file.path);
    } catch (cause) {
      if (!(await store.exists(file.path))) {
        skipped.push(file.path);
        onFile(file);
        continue;
      }
      throw cause;
    }

    const mtime = Math.max(file.mtime, ZIP_EPOCH_MS);
    if (options.encryptionKey) {
      const sealed = await encrypt(
        options.encryptionKey,
        deflateSync(data, { level }),
        options.chunkSize,
      );
      const entry = new ZipPassThrough(file.path);
      entry.mtime = mtime;
      zip.add(entry);
      entry.push(sealed, true);
    } else {
      const entry = new ZipDeflate(file.path, { level });
      entry.mtime = mtime;
      zip.add(entry);
      entry.push(data, true);
    }

    entries.push({
      path: file.path,
      size: data.length,
      mtime: file.mtime,
      sha256: sha256Hex(data),
    });
    onFile(file);
    await yieldIfNeeded();
  }

  zip.end();
  if (failure) throw new CryptoError("Could not build ZIP part", { cause: failure });

  const bytes = concatBytes(chunks);
  return { data: bytes, sha256: sha256Hex(bytes), entries, skipped };
}
