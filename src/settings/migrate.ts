import { ENCRYPTION, LIMITS, SCHEMA_VERSION } from "../constants";
import type { Settings, SettingsProfile } from "../types";
import { createDefaultSettings } from "./defaults";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Copy values from `raw` over `defaults`, keeping only keys that exist in `defaults`
 * and whose type matches. Anything missing or wrongly typed falls back to the default,
 * so a hand-edited or older settings file can never produce an invalid object.
 */
function mergeWithDefaults(defaults: unknown, raw: unknown): unknown {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(raw)) return defaults;
    const sample = defaults[0];
    const elementType = sample === undefined ? "string" : typeof sample;
    return raw.filter((item) => typeof item === elementType);
  }
  if (isObj(defaults)) {
    const source = isObj(raw) ? raw : {};
    const out: Obj = {};
    for (const key of Object.keys(defaults)) {
      out[key] = mergeWithDefaults(defaults[key], source[key]);
    }
    return out;
  }
  return typeof raw === typeof defaults ? raw : defaults;
}

const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;

/** Pull values back into their valid ranges. Never lets encryption drop below policy. */
function sanitizeProfile(p: SettingsProfile): SettingsProfile {
  p.basic.startupDelaySec = clamp(p.basic.startupDelaySec, 0, LIMITS.startupDelayMaxSec);
  p.zip.compressionLevel = Math.round(
    clamp(p.zip.compressionLevel, LIMITS.compressionLevelMin, LIMITS.compressionLevelMax),
  );
  p.encryption.kdfIterations = Math.max(p.encryption.kdfIterations, ENCRYPTION.minIterations);
  p.retention.keepLast = Math.max(1, Math.round(p.retention.keepLast));
  p.verification.samplingPct = clamp(p.verification.samplingPct, 0, 100);
  p.conditions.minBatteryPct = clamp(p.conditions.minBatteryPct, 0, 100);
  return p;
}

/**
 * Schema history:
 * - 0: one flat profile at the top level (before desktop/mobile profiles existed).
 * - 1: `{ schemaVersion, desktop, mobile }`.
 * Each step takes the previous shape and returns the next.
 */
const STEPS: Record<number, (raw: Obj) => Obj> = {
  0: (raw) => {
    const { schemaVersion: _ignored, ...profile } = raw;
    void _ignored;
    return { schemaVersion: 1, desktop: profile, mobile: profile };
  },
};

function detectVersion(raw: Obj): number {
  if (typeof raw.schemaVersion === "number") return raw.schemaVersion;
  return "desktop" in raw || "mobile" in raw ? SCHEMA_VERSION.settings : 0;
}

/** Turn whatever `loadData()` returned into a valid, current `Settings`. */
export function migrateSettings(raw: unknown): Settings {
  const defaults = createDefaultSettings();
  if (!isObj(raw)) return defaults;

  let current: Obj = raw;
  for (let v = detectVersion(raw); v < SCHEMA_VERSION.settings; v++) {
    const step = STEPS[v];
    if (step) current = step(current);
  }

  const merged = mergeWithDefaults(defaults, current) as Settings;
  merged.schemaVersion = SCHEMA_VERSION.settings;
  sanitizeProfile(merged.desktop);
  sanitizeProfile(merged.mobile);
  return merged;
}
