import { importAesKey, decrypt, encrypt } from "../crypto/cipher";
import { deriveKeyBytes, generateSalt } from "../crypto/kdf";
import { ENCRYPTION } from "../constants";
import { fromBase64, toBase64 } from "../helpers/bytes";
import { ConfigError, WrongPassphraseError } from "../helpers/errors";

export const PROTECTED_URI_PREFIX = "rewind-vault://settings-protected/";
export const MIN_SETTINGS_PASSPHRASE_CHARS = 8;
const VERSION = 1;

interface ProtectedEnvelope {
  v: number;
  salt: string;
  iterations: number;
  data: string;
}

const toUrl = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromUrl(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

/** True when the text is a passphrase-protected settings link. */
export function isProtectedLink(text: string): boolean {
  return text.trim().startsWith(PROTECTED_URI_PREFIX);
}

/**
 * Encrypt a settings link with a passphrase (AES-256-GCM, key from PBKDF2-SHA256 with a random
 * salt), so it can be shared over an untrusted channel. The settings never contain the backup
 * passphrase either way; this protects the rest (folders, schedules, exclusions).
 */
export async function protectLink(
  link: string,
  passphrase: string,
  iterations: number = ENCRYPTION.minIterations,
): Promise<string> {
  if (passphrase.length < MIN_SETTINGS_PASSPHRASE_CHARS) {
    throw new ConfigError(
      `The passphrase must be at least ${MIN_SETTINGS_PASSPHRASE_CHARS} characters`,
    );
  }
  const salt = generateSalt();
  const key = await importAesKey(await deriveKeyBytes(passphrase, salt, iterations));
  const encrypted = await encrypt(key, new TextEncoder().encode(link));
  const envelope: ProtectedEnvelope = {
    v: VERSION,
    salt: toBase64(salt),
    iterations,
    data: toBase64(encrypted),
  };
  return PROTECTED_URI_PREFIX + toUrl(new TextEncoder().encode(JSON.stringify(envelope)));
}

/**
 * Decrypt a protected link back to the plain settings link. Throws WrongPassphraseError for a
 * wrong passphrase or altered data (GCM cannot tell the two apart) and ConfigError for text
 * that is not a protected link. An attacker-chosen iteration count is bounded so a crafted
 * link cannot freeze the app.
 */
export async function unprotectLink(text: string, passphrase: string): Promise<string> {
  const trimmed = text.trim();
  if (!isProtectedLink(trimmed)) throw new ConfigError("That is not a protected settings link");
  let envelope: ProtectedEnvelope;
  try {
    envelope = JSON.parse(
      new TextDecoder().decode(fromUrl(trimmed.slice(PROTECTED_URI_PREFIX.length))),
    ) as ProtectedEnvelope;
    if (
      envelope.v !== VERSION ||
      typeof envelope.salt !== "string" ||
      typeof envelope.data !== "string" ||
      !Number.isInteger(envelope.iterations)
    ) {
      throw new Error("bad envelope");
    }
  } catch {
    throw new ConfigError("That protected settings link is damaged");
  }
  if (envelope.iterations < ENCRYPTION.minIterations || envelope.iterations > 10_000_000) {
    throw new ConfigError("That protected settings link uses unsupported key settings");
  }
  try {
    const key = await importAesKey(
      await deriveKeyBytes(passphrase, fromBase64(envelope.salt), envelope.iterations),
    );
    return new TextDecoder().decode(await decrypt(key, fromBase64(envelope.data)));
  } catch (cause) {
    throw new WrongPassphraseError({ cause });
  }
}
