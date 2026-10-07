import { inflateSync } from "fflate";
import { sha256Hex } from "../crypto/hash";
import { crc32 } from "../helpers/crc32";
import type { ZipDirectoryEntry } from "../helpers/zipDirectory";
import type { ManifestPart, VerifyIssue } from "../types";

/** Raw (still compressed, possibly encrypted) bytes of an entry, as stored in the part. */
function storedBytes(data: Uint8Array, entry: ZipDirectoryEntry): Uint8Array {
  return data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
}

/**
 * Level 2, integrity, for one part: the part's SHA-256 matches the manifest, and every entry
 * decodes to bytes whose CRC-32 equals the one in the ZIP directory (so a flipped byte is
 * found and attributed to the entry it damaged). Entries of encrypted backups are stored
 * as-is, so their CRC covers the stored bytes. Needs a full read of the part.
 */
export async function checkPartCrc(
  part: ManifestPart,
  data: Uint8Array,
  directory: ZipDirectoryEntry[],
  issues: VerifyIssue[],
  tick: () => Promise<void>,
): Promise<void> {
  if (sha256Hex(data) !== part.sha256) {
    issues.push({ part: part.name, message: "Part content does not match its recorded SHA-256" });
  }
  for (const entry of directory) {
    const problem = (message: string): void => {
      issues.push({ part: part.name, path: entry.name, message });
    };
    const stored = storedBytes(data, entry);
    let decoded: Uint8Array;
    try {
      decoded = entry.method === 8 ? inflateSync(stored) : stored;
    } catch {
      problem("Entry data cannot be decompressed");
      await tick();
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8) {
      problem(`Entry uses unsupported compression method ${entry.method}`);
    } else if (decoded.length !== entry.size) {
      problem(`Entry decodes to ${decoded.length} bytes, the ZIP directory records ${entry.size}`);
    } else if (crc32(decoded) !== entry.crc32) {
      problem("Entry fails its CRC-32 check");
    }
    await tick();
  }
}
