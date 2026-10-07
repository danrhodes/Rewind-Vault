import { describe, expect, it } from "vitest";
import { ENCRYPTION } from "../../src/constants";
import { createDefaultProfile } from "../../src/settings/defaults";
import { migrateSettings } from "../../src/settings/migrate";
import {
  DEFERRED,
  GROUPS,
  LINKED,
  SETTINGS_SCHEMA,
  applyField,
  coerceValue,
  fieldId,
  fieldsFor,
  getFieldValue,
  isFieldShown,
  type FieldDef,
} from "../../src/settings/schema";
import type { SettingsProfile } from "../../src/types";

const find = (id: string): FieldDef => {
  const def = SETTINGS_SCHEMA.find((f) => fieldId(f) === id);
  if (!def) throw new Error(`no field ${id}`);
  return def;
};

function leaves(profile: SettingsProfile): string[] {
  const out: string[] = [];
  for (const [group, values] of Object.entries(profile)) {
    for (const key of Object.keys(values as Record<string, unknown>)) out.push(`${group}.${key}`);
  }
  return out;
}

describe("settings schema covers every setting", () => {
  for (const kind of ["desktop", "mobile"] as const) {
    it(`every ${kind} profile setting is in the tab, linked, or deferred to a named task`, () => {
      const shown = new Set(SETTINGS_SCHEMA.map(fieldId));
      for (const id of leaves(createDefaultProfile(kind))) {
        const ok = shown.has(id) || id in LINKED || id in DEFERRED;
        expect(ok, `setting ${id} is not reachable in the settings tab`).toBe(true);
      }
    });
  }

  it("has no field that does not exist in the data model, and no duplicates", () => {
    const real = new Set(leaves(createDefaultProfile("desktop")));
    const seen = new Set<string>();
    for (const def of SETTINGS_SCHEMA) {
      const id = fieldId(def);
      expect(real.has(id), `unknown setting ${id}`).toBe(true);
      expect(seen.has(id), `duplicate ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it("linked and deferred entries point at real settings and fields", () => {
    const real = new Set(leaves(createDefaultProfile("desktop")));
    const shown = new Set(SETTINGS_SCHEMA.map(fieldId));
    for (const [id, target] of Object.entries(LINKED)) {
      expect(real.has(id)).toBe(true);
      expect(shown.has(target)).toBe(true);
    }
    for (const id of Object.keys(DEFERRED)) expect(real.has(id)).toBe(true);
  });

  it("every group has a section and every field names and describes itself", () => {
    const groups = new Set(GROUPS.map((g) => g.key));
    expect([...groups].sort()).toEqual(Object.keys(createDefaultProfile("desktop")).sort());
    for (const def of SETTINGS_SCHEMA) {
      expect(groups.has(def.group)).toBe(true);
      expect(def.name.length).toBeGreaterThan(2);
      expect(def.desc.length).toBeGreaterThan(5);
    }
  });

  it("each field kind matches the type of its default value", () => {
    const profile = createDefaultProfile("desktop") as unknown as Record<
      string,
      Record<string, unknown>
    >;
    for (const def of SETTINGS_SCHEMA) {
      const value = profile[def.group]?.[def.key];
      const expected =
        def.kind === "toggle"
          ? "boolean"
          : def.kind === "number"
            ? "number"
            : def.kind === "list"
              ? "array"
              : "string";
      expect(Array.isArray(value) ? "array" : typeof value, fieldId(def)).toBe(expected);
    }
  });

  it("defaults sit inside every number range and dropdown", () => {
    for (const kind of ["desktop", "mobile"] as const) {
      const profile = createDefaultProfile(kind);
      for (const def of SETTINGS_SCHEMA) {
        const value = getFieldValue(profile, def);
        if (def.kind === "number") {
          expect(value, `${kind} ${fieldId(def)}`).toBeGreaterThanOrEqual(def.min);
          expect(value, `${kind} ${fieldId(def)}`).toBeLessThanOrEqual(def.max);
        }
        if (def.kind === "dropdown") {
          expect(
            def.options.map((o) => o.value),
            fieldId(def),
          ).toContain(value);
        }
      }
    }
  });

  it("ranges agree with what migrate enforces on load", () => {
    const settings = migrateSettings({
      desktop: { zip: { compressionLevel: 99 }, basic: { startupDelaySec: -5 } },
    });
    expect(settings.desktop.zip.compressionLevel).toBe(
      (find("zip.compressionLevel") as { max: number }).max,
    );
    expect(settings.desktop.basic.startupDelaySec).toBe(
      (find("basic.startupDelaySec") as { min: number }).min,
    );
    expect((find("encryption.kdfIterations") as { min: number }).min).toBe(
      ENCRYPTION.minIterations,
    );
  });
});

describe("platform and dependency visibility", () => {
  it("desktop-only fields are hidden on mobile and shown on desktop", () => {
    const mobile = fieldsFor("triggers", "mobile").map((f) => f.key);
    const desktop = fieldsFor("triggers", "desktop").map((f) => f.key);
    expect(mobile).not.toContain("onClose");
    expect(desktop).toContain("onClose");
    expect(fieldsFor("destination", "mobile").map((f) => f.key)).toEqual([
      "backupFolder",
      "restoreFolder",
    ]);
    expect(fieldsFor("notifications", "mobile").map((f) => f.key)).not.toContain("statusBar");
  });

  it("dependent fields appear only while their switch has the required value", () => {
    const profile = createDefaultProfile("desktop");
    const gfsDaily = find("retention.gfsDaily");
    profile.retention.gfsEnabled = false;
    expect(isFieldShown(profile, gfsDaily, "desktop")).toBe(false);
    profile.retention.gfsEnabled = true;
    expect(isFieldShown(profile, gfsDaily, "desktop")).toBe(true);
    const external = find("destination.externalPath");
    expect(isFieldShown(profile, external, "desktop")).toBe(false);
    profile.destination.destination = "external";
    expect(isFieldShown(profile, external, "desktop")).toBe(true);
    expect(isFieldShown(profile, external, "mobile")).toBe(false);
  });
});

describe("coerceValue", () => {
  it("numbers: parses text, rounds, clamps, rejects junk", () => {
    const delay = find("basic.startupDelaySec");
    expect(coerceValue(delay, "30")).toEqual({ ok: true, value: 30 });
    expect(coerceValue(delay, " 12.6 ")).toEqual({ ok: true, value: 13 });
    expect(coerceValue(delay, "9999")).toEqual({ ok: true, value: 300 });
    expect(coerceValue(delay, -4)).toEqual({ ok: true, value: 0 });
    for (const junk of ["", "  ", "abc", NaN, Infinity]) {
      expect(coerceValue(delay, junk).ok, String(junk)).toBe(false);
    }
  });

  it("kdf iterations cannot go below the policy minimum", () => {
    expect(coerceValue(find("encryption.kdfIterations"), "1000")).toEqual({
      ok: true,
      value: ENCRYPTION.minIterations,
    });
  });

  it("toggles accept booleans only", () => {
    const t = find("zip.processOverMax");
    expect(coerceValue(t, true)).toEqual({ ok: true, value: true });
    expect(coerceValue(t, "true").ok).toBe(false);
  });

  it("dropdowns accept listed values only", () => {
    const d = find("notifications.level");
    expect(coerceValue(d, "verbose")).toEqual({ ok: true, value: "verbose" });
    expect(coerceValue(d, "loud").ok).toBe(false);
  });

  it("folders: trims, drops trailing slashes, rejects empty, absolute, .. and backslashes", () => {
    const f = find("destination.backupFolder");
    expect(coerceValue(f, "  Archive/backup// ")).toEqual({ ok: true, value: "Archive/backup" });
    for (const badPath of ["", "   ", "/abs", "../up", "a/../b", "a\\b", "a//b"]) {
      expect(coerceValue(f, badPath).ok, badPath).toBe(false);
    }
  });

  it("daily times: validates HH:MM, de-duplicates, sorts, ignores blank lines", () => {
    const t = find("triggers.dailyTimes");
    expect(coerceValue(t, "18:30\n\n09:00\r\n09:00\n")).toEqual({
      ok: true,
      value: ["09:00", "18:30"],
    });
    expect(coerceValue(t, "")).toEqual({ ok: true, value: [] });
    for (const badTime of ["9:00", "24:00", "12:60", "noon", "09:00 pm"]) {
      expect(coerceValue(t, badTime).ok, badTime).toBe(false);
    }
  });

  it("glob list: one trimmed pattern per line, order kept", () => {
    const g = find("exclusions.globs");
    expect(coerceValue(g, "  *.tmp \n\nattachments/\n!keep.md")).toEqual({
      ok: true,
      value: ["*.tmp", "attachments/", "!keep.md"],
    });
  });

  it("plain text is trimmed and the password is kept exactly", () => {
    expect(coerceValue(find("destination.externalPath"), "  D:\\x ")).toEqual({
      ok: true,
      value: "D:\\x",
    });
    expect(coerceValue(find("encryption.passphrase"), "  sp ace  ")).toEqual({
      ok: true,
      value: "  sp ace  ",
    });
  });
});

describe("applyField", () => {
  it("stores the normalised value and returns it", () => {
    const profile = createDefaultProfile("desktop");
    const result = applyField(profile, find("zip.compressionLevel"), "42");
    expect(result).toEqual({ ok: true, value: 9 });
    expect(profile.zip.compressionLevel).toBe(9);
  });

  it("leaves the profile untouched when the value is invalid", () => {
    const profile = createDefaultProfile("desktop");
    const before = JSON.stringify(profile);
    expect(applyField(profile, find("destination.backupFolder"), "../x").ok).toBe(false);
    expect(JSON.stringify(profile)).toBe(before);
  });

  it("the startup switch drives both stored flags, and reads as on only when both are on", () => {
    const profile = createDefaultProfile("desktop");
    const startup = find("basic.backupOnStartup");
    applyField(profile, startup, false);
    expect(profile.basic.backupOnStartup).toBe(false);
    expect(profile.triggers.onStartup).toBe(false);
    applyField(profile, startup, true);
    expect(profile.triggers.onStartup).toBe(true);
    expect(getFieldValue(profile, startup)).toBe(true);
    profile.triggers.onStartup = false; // an old file where only one was off
    expect(getFieldValue(profile, startup)).toBe(false);
  });

  it("every field accepts its own current value unchanged (round trip)", () => {
    for (const kind of ["desktop", "mobile"] as const) {
      const profile = createDefaultProfile(kind);
      const before = JSON.stringify(profile);
      for (const def of SETTINGS_SCHEMA) {
        const current = getFieldValue(profile, def);
        const raw = def.kind === "list" ? (current as string[]).join("\n") : current;
        const result = applyField(profile, def, raw);
        expect(result.ok, `${kind} ${fieldId(def)}`).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(profile))).toEqual(JSON.parse(before));
    }
  });
});
