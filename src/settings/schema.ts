import { isSafeRelPath } from "../helpers/validate";
import type { PlatformKind, SettingsProfile } from "../types";
import { FIELDS_A } from "./schemaFieldsA";
import { FIELDS_B } from "./schemaFieldsB";
import { FIELDS_C } from "./schemaFieldsC";
import { FIELDS_D } from "./schemaFieldsD";
import { fieldId, type FieldDef, type GroupKey } from "./schemaTypes";

export * from "./schemaTypes";

/** Every setting the tab shows, in display order. */
export const SETTINGS_SCHEMA: readonly FieldDef[] = [
  ...FIELDS_A,
  ...FIELDS_C,
  ...FIELDS_B,
  ...FIELDS_D,
];

export type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Bag = Record<string, unknown>;
const bag = (profile: SettingsProfile, group: GroupKey): Bag => profile[group] as unknown as Bag;

export function fieldsFor(group: GroupKey, kind: PlatformKind): FieldDef[] {
  return SETTINGS_SCHEMA.filter((f) => f.group === group && !(f.desktopOnly && kind === "mobile"));
}

export function getFieldValue(profile: SettingsProfile, def: FieldDef): unknown {
  // Startup has two stored switches (Basic and Triggers); a backup runs only if both are on.
  if (fieldId(def) === "basic.backupOnStartup") {
    return profile.basic.backupOnStartup && profile.triggers.onStartup;
  }
  return bag(profile, def.group)[def.key];
}

/** Whether the field is visible: not hidden by its `shownIf` dependency or by the platform. */
export function isFieldShown(profile: SettingsProfile, def: FieldDef, kind: PlatformKind): boolean {
  if (def.desktopOnly && kind === "mobile") return false;
  if (!def.shownIf) return true;
  return bag(profile, def.group)[def.shownIf.key] === def.shownIf.value;
}

/** Validate and normalise what the user entered. Never throws and never changes the profile. */
export function coerceValue(def: FieldDef, raw: unknown): Coerced {
  switch (def.kind) {
    case "toggle":
      return typeof raw === "boolean" ? { ok: true, value: raw } : bad("Must be on or off.");
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (String(raw).trim() === "" || !Number.isFinite(n)) return bad("Enter a number.");
      const value = Math.min(def.max, Math.max(def.min, def.integer === false ? n : Math.round(n)));
      return { ok: true, value };
    }
    case "dropdown":
      return def.options.some((o) => o.value === raw)
        ? { ok: true, value: raw }
        : bad("Unknown option.");
    case "password":
      return { ok: true, value: String(raw) };
    case "text":
      return def.validate === "folder"
        ? coerceFolder(String(raw))
        : { ok: true, value: String(raw).trim() };
    case "list":
      return coerceList(def.validate, raw);
  }
}

function bad(message: string): Coerced {
  return { ok: false, message };
}

function coerceFolder(raw: string): Coerced {
  const value = raw.trim().replace(/\/+$/, "");
  if (value === "") return bad("A folder is required.");
  if (!isSafeRelPath(value))
    return bad("Use a path inside the vault, like backup or Archive/backup.");
  return { ok: true, value };
}

function coerceList(validate: "time" | undefined, raw: unknown): Coerced {
  const lines = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (validate === "time") {
    const invalid = lines.find((l) => !TIME.test(l));
    if (invalid !== undefined)
      return bad(`"${invalid}" is not a time. Use HH:MM, for example 09:30.`);
    return { ok: true, value: [...new Set(lines)].sort() };
  }
  return { ok: true, value: lines };
}

/**
 * Validate and store one field in `profile`. Returns the normalised value so the UI can show
 * what was actually saved (for example a number clamped into range).
 */
export function applyField(profile: SettingsProfile, def: FieldDef, raw: unknown): Coerced {
  const result = coerceValue(def, raw);
  if (!result.ok) return result;
  bag(profile, def.group)[def.key] = result.value;
  if (fieldId(def) === "basic.backupOnStartup") profile.triggers.onStartup = result.value === true;
  return result;
}
