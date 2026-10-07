import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey, keyCheckValue } from "../crypto/kdf";
import { verifyManifestSignature } from "../crypto/sign";
import { fromBase64 } from "../helpers/bytes";
import { CancelledError, RewindError } from "../helpers/errors";
import type { Manifest, VerifyIssue, VerifyLevel } from "../types";
import type { MasterKeyFn } from "./RestoreReader";

/**
 * Key work for levels 3 and 4 on an encrypted backup. Returns the entry decryption key, or
 * undefined when none could be had; in that case the reason is an `issue` (wrong passphrase:
 * a real finding) or a `skipped` note (no passphrase available: nothing could be checked).
 *
 * Level 4 additionally checks the manifest's HMAC signature and says plainly when the
 * decrypt check does not apply (unencrypted backup) or could not run (no passphrase).
 */
export async function prepareKeys(
  deriveMasterKey: MasterKeyFn | undefined,
  manifest: Manifest,
  level: VerifyLevel,
  issues: VerifyIssue[],
  skipped: string[],
): Promise<CryptoKey | undefined> {
  const info = manifest.encryption;
  if (level < 3) return undefined;
  if (!info.enabled) {
    if (level >= 4) skipped.push("The backup is not encrypted: decrypt check not applicable");
    return undefined;
  }
  if (!deriveMasterKey) {
    skipped.push(
      level >= 4
        ? "The decrypt check and manifest signature need the passphrase; not run"
        : "Entry SHA-256 of an encrypted backup needs the passphrase; not checked",
    );
    return undefined;
  }

  let master: Uint8Array;
  try {
    master = await deriveMasterKey(fromBase64(info.salt), info.iterations);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    const why = error instanceof RewindError ? error.message : "key derivation failed";
    skipped.push(`Encrypted backup not checked beyond L2: ${why}`);
    return undefined;
  }

  if (info.keyCheck !== undefined && (await keyCheckValue(master)) !== info.keyCheck) {
    issues.push({
      message: "Wrong passphrase: it is not the one this backup was encrypted with",
    });
    return undefined;
  }
  if (level >= 4) {
    const signed = await verifyManifestSignature(
      manifest,
      await deriveSubKey(master, KEY_LABELS.manifestHmac),
    );
    if (!signed) {
      issues.push({
        message: manifest.hmac
          ? "Manifest signature is invalid (the manifest was altered, or the passphrase is wrong)"
          : "Manifest of an encrypted backup is not signed",
      });
    }
  }
  return importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
}
