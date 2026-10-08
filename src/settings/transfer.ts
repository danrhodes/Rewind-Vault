import { fromBase64, toBase64 } from "../helpers/bytes";
import type { PlatformKind, Settings } from "../types";
import { migrateSettings } from "./migrate";

export const TRANSFER_FORMAT = "rewind-vault-settings";
export const TRANSFER_VERSION = 1;
export const TRANSFER_URI_PREFIX = "rewind-vault://settings/";
/** Longest text accepted for import; real settings are a few KB. */
export const MAX_TRANSFER_CHARS = 200_000;

interface Envelope {
  format: string;
  version: number;
  settings: unknown;
}

/** `scope` says which profile(s) the import replaces: both, or only one platform's. */
export type ImportScope = "both" | PlatformKind;
export type ImportResult =
  { ok: true; settings: Settings; scope?: ImportScope } | { ok: false; error: string };

const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

/**
 * Settings as a copy-and-paste link for another device or vault: both the desktop and the
 * mobile profile. The stored passphrase is NEVER included (it would sit in the clipboard and
 * chat logs); the receiving device keeps its own.
 */
export function exportSettings(settings: Settings): string {
  const copy = JSON.parse(JSON.stringify(settings)) as Settings;
  copy.desktop.encryption.passphrase = "";
  copy.mobile.encryption.passphrase = "";
  const envelope: Envelope = { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, settings: copy };
  return TRANSFER_URI_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
}

function payloadOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(TRANSFER_URI_PREFIX)) {
    return new TextDecoder().decode(fromBase64Url(trimmed.slice(TRANSFER_URI_PREFIX.length)));
  }
  if (trimmed.startsWith("{")) return trimmed;
  return new TextDecoder().decode(fromBase64Url(trimmed));
}

/**
 * Read exported settings from a link, bare base64 or the JSON itself. Never throws. The result
 * is passed through `migrateSettings`, so unknown keys are dropped, wrong types fall back to
 * defaults and ranges are clamped: a hand-edited or damaged link cannot produce invalid settings.
 */
export function importSettings(text: string): ImportResult {
  if (text.length > MAX_TRANSFER_CHARS) return { ok: false, error: "The text is too long." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadOf(text));
  } catch {
    return { ok: false, error: "That is not a Rewind Vault settings link." };
  }
  const envelope = parsed as Partial<Envelope> | null;
  if (!envelope || typeof envelope !== "object" || envelope.format !== TRANSFER_FORMAT) {
    return { ok: false, error: "That is not a Rewind Vault settings link." };
  }
  if (envelope.version !== TRANSFER_VERSION) {
    return { ok: false, error: `Unsupported settings link version ${String(envelope.version)}.` };
  }
  return { ok: true, settings: migrateSettings(envelope.settings) };
}

/**
 * Replace `target`'s settings with imported ones, in place (the settings tab and services hold
 * the same object). Local secrets are kept: an import never changes the stored passphrase.
 */
export function applyImportedSettings(
  target: Settings,
  imported: Settings,
  scope: ImportScope = "both",
): void {
  const keep = {
    desktop: target.desktop.encryption.passphrase,
    mobile: target.mobile.encryption.passphrase,
  };
  target.schemaVersion = imported.schemaVersion;
  if (scope === "both" || scope === "desktop") target.desktop = imported.desktop;
  if (scope === "both" || scope === "mobile") target.mobile = imported.mobile;
  target.desktop.encryption.passphrase = keep.desktop;
  target.mobile.encryption.passphrase = keep.mobile;
}
