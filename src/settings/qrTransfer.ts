import { deflateSync, inflateSync } from "fflate";
import { fromBase64, toBase64 } from "../helpers/bytes";
import { QR_MAX_BYTES } from "../helpers/qr";
import type { PlatformKind, Settings } from "../types";
import { createDefaultSettings } from "./defaults";
import { migrateSettings } from "./migrate";
import type { ImportResult } from "./transfer";

export const QR_PREFIX = "RVQ1:";
/** Longest text read back from a scan; the largest QR code holds QR_MAX_BYTES. */
const MAX_INFLATED_BYTES = 64 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const toUrl = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromUrl(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

/** Only the values that differ from the defaults, as nested `{group: {key: value}}`. */
function diffFromDefaults(profile: Obj, defaults: Obj): Obj {
  const out: Obj = {};
  for (const group of Object.keys(defaults)) {
    const mine = profile[group];
    const base = defaults[group];
    if (!isObj(mine) || !isObj(base)) continue;
    const changed: Obj = {};
    for (const key of Object.keys(base)) {
      if (group === "encryption" && key === "passphrase") continue; // never leaves the device
      if (JSON.stringify(mine[key]) !== JSON.stringify(base[key])) changed[key] = mine[key];
    }
    if (Object.keys(changed).length > 0) out[group] = changed;
  }
  return out;
}

export type QrPayloadResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * A short text for a QR code: this device's settings that differ from the defaults, deflated.
 * The stored passphrase is never included. Returns an error when even that is too big for a
 * QR code (then use the settings link instead).
 */
export function buildQrPayload(settings: Settings, platform: PlatformKind): QrPayloadResult {
  const defaults = createDefaultSettings();
  const diff = diffFromDefaults(
    settings[platform] as unknown as Obj,
    defaults[platform] as unknown as Obj,
  );
  const packed = deflateSync(
    new TextEncoder().encode(JSON.stringify({ v: 1, p: platform, d: diff })),
    {
      level: 9,
    },
  );
  const text = QR_PREFIX + toUrl(packed);
  if (text.length > QR_MAX_BYTES) {
    return {
      ok: false,
      error:
        "Too many settings differ from the defaults to fit in a QR code. Use the settings link.",
    };
  }
  return { ok: true, text };
}

/**
 * Read a QR payload on this device. The sender's changes are applied on top of THIS device's
 * defaults, and only this device's profile is replaced (`scope`), so a phone scanning a desktop
 * code does not touch the desktop profile it carries. Never throws; values are sanitised by
 * `migrateSettings` like any import.
 */
export function parseQrPayload(text: string, platform: PlatformKind): ImportResult {
  const bad: ImportResult = { ok: false, error: "That is not a Rewind Vault settings QR code." };
  const trimmed = text.trim();
  if (!trimmed.startsWith(QR_PREFIX)) return bad;
  let payload: unknown;
  try {
    const inflated = inflateSync(fromUrl(trimmed.slice(QR_PREFIX.length)));
    if (inflated.length > MAX_INFLATED_BYTES) return bad;
    payload = JSON.parse(new TextDecoder().decode(inflated));
  } catch {
    return bad;
  }
  if (!isObj(payload) || payload.v !== 1 || !isObj(payload.d)) return bad;
  const defaults = createDefaultSettings();
  const merged: Obj = JSON.parse(JSON.stringify(defaults[platform])) as Obj;
  for (const [group, values] of Object.entries(payload.d)) {
    const target = merged[group];
    if (isObj(target) && isObj(values)) Object.assign(target, values);
  }
  const candidate = { ...defaults, [platform]: merged };
  return { ok: true, settings: migrateSettings(candidate), scope: platform };
}
