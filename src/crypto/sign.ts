import { bufferSource, fromBase64, toBase64 } from "../helpers/bytes";
import { CryptoError } from "../helpers/errors";
import type { Manifest } from "../types";

/** Fields excluded from the signature: they change after creation (verification, state changes). */
const UNSIGNED_FIELDS: ReadonlySet<string> = new Set(["hmac", "status", "verify"]);

/** JSON with object keys sorted at every level, so equal data always serialises identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function signedBytes(manifest: Manifest): Uint8Array {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (!UNSIGNED_FIELDS.has(key)) body[key] = value;
  }
  return new TextEncoder().encode(canonicalJson(body));
}

function importHmacKey(key: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bufferSource(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * Base64 HMAC-SHA256 over the manifest's immutable content. `status`, `verify` and
 * `hmac` are not covered. `key` should come from deriveSubKey(master, KEY_LABELS.manifestHmac).
 */
export async function signManifest(manifest: Manifest, key: Uint8Array): Promise<string> {
  try {
    const k = await importHmacKey(key, "sign");
    const sig = await crypto.subtle.sign("HMAC", k, bufferSource(signedBytes(manifest)));
    return toBase64(new Uint8Array(sig));
  } catch (cause) {
    throw new CryptoError("Could not sign manifest", { cause });
  }
}

/** Constant-time check. False when unsigned, malformed, tampered, or signed with another key. */
export async function verifyManifestSignature(
  manifest: Manifest,
  key: Uint8Array,
): Promise<boolean> {
  if (typeof manifest.hmac !== "string" || manifest.hmac === "") return false;
  let signature: Uint8Array;
  try {
    signature = fromBase64(manifest.hmac);
  } catch {
    return false;
  }
  const k = await importHmacKey(key, "verify");
  return crypto.subtle.verify(
    "HMAC",
    k,
    bufferSource(signature),
    bufferSource(signedBytes(manifest)),
  );
}
