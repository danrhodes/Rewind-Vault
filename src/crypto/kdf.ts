import { ENCRYPTION } from "../constants";
import { bufferSource } from "../helpers/bytes";
import { ConfigError, CryptoError } from "../helpers/errors";

export function generateSalt(bytes: number = ENCRYPTION.saltBytes): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

/**
 * Raw PBKDF2-HMAC-SHA256 with no policy checks. Exposed so tests can use published
 * low-iteration vectors. Application code must call `deriveKeyBytes` instead.
 */
export async function pbkdf2Sha256(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  lengthBytes: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new ConfigError("PBKDF2 iterations must be a positive integer");
  }
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      bufferSource(new TextEncoder().encode(passphrase)),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: bufferSource(salt), iterations },
      material,
      lengthBytes * 8,
    );
    return new Uint8Array(bits);
  } catch (cause) {
    throw new CryptoError("Key derivation failed", { cause });
  }
}

/** Throws if `iterations` is below the policy minimum (PLAN section 6: 600,000). */
export function assertIterations(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < ENCRYPTION.minIterations) {
    throw new ConfigError(
      `KDF iterations must be at least ${ENCRYPTION.minIterations}, got ${iterations}`,
    );
  }
}

/** Derive a 256-bit key from a passphrase. Enforces the minimum iteration count. */
export async function deriveKeyBytes(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = ENCRYPTION.minIterations,
): Promise<Uint8Array> {
  assertIterations(iterations);
  if (passphrase.length === 0) throw new ConfigError("Passphrase must not be empty");
  return pbkdf2Sha256(passphrase, salt, iterations, 32);
}
