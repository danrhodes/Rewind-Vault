import { inflateSync } from "fflate";
import { decrypt } from "../crypto/cipher";
import { sha256Hex } from "../crypto/hash";
import { crc32 } from "../helpers/crc32";
import type { ZipDirectoryEntry } from "../helpers/zipDirectory";
import type { ManifestEntry, ManifestPart, VerifyIssue } from "../types";

export interface PartContentCheck {
  part: ManifestPart;
  data: Uint8Array;
  directory: ZipDirectoryEntry[];
  /** Manifest entries of this part by path (for the SHA-256 check). */
  expected: ReadonlyMap<string, ManifestEntry>;
  /** 2 = part hash + CRC-32; 3 adds SHA-256 of every entry against the manifest. */
  level: 2 | 3;
  /** Needed to read inside encrypted entries at level 3. */
  encryptionKey?: CryptoKey;
  /** When set, only these entries get the content checks (structure is always complete). */
  sample?: ReadonlySet<string>;
  /** Called after each entry: polls cancel and yields. */
  tick: () => Promise<void>;
}

/** Raw (still compressed, possibly encrypted) bytes of an entry, as stored in the part. */
function storedBytes(data: Uint8Array, entry: ZipDirectoryEntry): Uint8Array {
  return data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
}

/**
 * Levels 2 and 3 for one part, needing a full read of it.
 *
 * L2: the part's SHA-256 matches the manifest, and every entry decodes to bytes whose size and
 * CRC-32 equal the ZIP directory's (a flipped byte is found and attributed to its entry).
 * Encrypted entries are stored as-is, so their CRC covers the stored ciphertext.
 *
 * L3: the SHA-256 of each entry's real content equals the one in the manifest. This catches
 * what a CRC cannot: an entry replaced by different content with a recomputed CRC. For
 * encrypted entries it needs the key, because the hash is of the plaintext.
 */
export async function checkPartContent(
  check: PartContentCheck,
  issues: VerifyIssue[],
): Promise<void> {
  const { part, data } = check;
  const sampled = (name: string): boolean => !check.sample || check.sample.has(name);
  // A part is hashed whole, so when sampling only parts that hold a sampled entry are hashed.
  if (check.directory.some((e) => sampled(e.name)) && sha256Hex(data) !== part.sha256) {
    issues.push({ part: part.name, message: "Part content does not match its recorded SHA-256" });
  }
  for (const entry of check.directory) {
    if (!sampled(entry.name)) {
      await check.tick();
      continue;
    }
    const problem = (message: string): void => {
      issues.push({ part: part.name, path: entry.name, message });
    };
    await checkEntry(check, entry, problem);
    await check.tick();
  }
}

async function checkEntry(
  check: PartContentCheck,
  entry: ZipDirectoryEntry,
  problem: (message: string) => void,
): Promise<void> {
  const stored = storedBytes(check.data, entry);
  if (entry.method !== 0 && entry.method !== 8) {
    problem(`Entry uses unsupported compression method ${entry.method}`);
    return;
  }
  let decoded: Uint8Array;
  try {
    decoded = entry.method === 8 ? inflateSync(stored) : stored;
  } catch {
    problem("Entry data cannot be decompressed");
    return;
  }
  if (decoded.length !== entry.size) {
    problem(`Entry decodes to ${decoded.length} bytes, the ZIP directory records ${entry.size}`);
    return;
  }
  if (crc32(decoded) !== entry.crc32) {
    problem("Entry fails its CRC-32 check");
    return;
  }
  if (check.level < 3) return;

  const want = check.expected.get(entry.name);
  if (!want) return; // reported by the structure check
  let plain = decoded;
  if (check.encryptionKey) {
    try {
      plain = inflateSync(await decrypt(check.encryptionKey, decoded));
    } catch {
      problem("Entry cannot be decrypted (wrong passphrase, or the data was altered)");
      return;
    }
  }
  if (sha256Hex(plain) !== want.sha256) {
    problem("Entry content does not match the SHA-256 in the manifest");
  }
}
