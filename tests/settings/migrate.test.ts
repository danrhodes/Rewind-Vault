import { describe, expect, it } from "vitest";
import { ENCRYPTION, SCHEMA_VERSION } from "../../src/constants";
import { createDefaultSettings } from "../../src/settings/defaults";
import { migrateSettings } from "../../src/settings/migrate";

describe("migrateSettings", () => {
  it("returns defaults for missing or junk input", () => {
    const defaults = createDefaultSettings();
    expect(migrateSettings(undefined)).toEqual(defaults);
    expect(migrateSettings(null)).toEqual(defaults);
    expect(migrateSettings("nope")).toEqual(defaults);
    expect(migrateSettings([1, 2])).toEqual(defaults);
  });

  it("round-trips current settings unchanged", () => {
    const s = createDefaultSettings();
    s.desktop.basic.autoStyle = "full";
    s.mobile.exclusions.globs = ["*.tmp", "drafts/"];
    s.desktop.triggers.dailyTimes = ["09:00", "21:30"];
    expect(migrateSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("fills in fields added by newer versions", () => {
    const s = JSON.parse(JSON.stringify(createDefaultSettings()));
    delete s.desktop.safety;
    delete s.mobile.basic.autoStyle;
    const out = migrateSettings(s);
    expect(out.desktop.safety).toEqual(createDefaultSettings().desktop.safety);
    expect(out.mobile.basic.autoStyle).toBe("differential");
  });

  it("v0 fixture: flat profile is copied into both desktop and mobile", () => {
    const v0 = {
      basic: { backupOnStartup: false, startupDelaySec: 42, autoStyle: "full" },
      destination: { backupFolder: "my-backups" },
      retention: { keepLast: 3 },
    };
    const out = migrateSettings(v0);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION.settings);
    for (const p of [out.desktop, out.mobile]) {
      expect(p.basic.backupOnStartup).toBe(false);
      expect(p.basic.startupDelaySec).toBe(42);
      expect(p.basic.autoStyle).toBe("full");
      expect(p.destination.backupFolder).toBe("my-backups");
      expect(p.destination.restoreFolder).toBe("restore");
      expect(p.retention.keepLast).toBe(3);
    }
    out.desktop.exclusions.globs.push("x");
    expect(out.mobile.exclusions.globs).toEqual([]);
  });

  it("drops unknown keys and wrongly typed values", () => {
    const out = migrateSettings({
      schemaVersion: 1,
      bogus: true,
      desktop: {
        basic: { startupDelaySec: "soon", unknownFlag: 1, includeHidden: false },
        triggers: { dailyTimes: ["08:00", 5, null] },
      },
    });
    expect(out).not.toHaveProperty("bogus");
    expect(out.desktop.basic).not.toHaveProperty("unknownFlag");
    expect(out.desktop.basic.startupDelaySec).toBe(15);
    expect(out.desktop.basic.includeHidden).toBe(false);
    expect(out.desktop.triggers.dailyTimes).toEqual(["08:00"]);
  });

  it("clamps out-of-range values and never allows weak KDF iterations", () => {
    const s = createDefaultSettings();
    s.desktop.basic.startupDelaySec = 9999;
    s.desktop.zip.compressionLevel = 15;
    s.desktop.encryption.kdfIterations = 1000;
    s.desktop.retention.keepLast = 0;
    s.desktop.verification.samplingPct = 250;
    s.mobile.conditions.minBatteryPct = -5;
    const out = migrateSettings(s);
    expect(out.desktop.basic.startupDelaySec).toBe(300);
    expect(out.desktop.zip.compressionLevel).toBe(9);
    expect(out.desktop.encryption.kdfIterations).toBe(ENCRYPTION.minIterations);
    expect(out.desktop.retention.keepLast).toBe(1);
    expect(out.desktop.verification.samplingPct).toBe(100);
    expect(out.mobile.conditions.minBatteryPct).toBe(0);
  });

  it("treats a newer schemaVersion as best effort and stamps the current one", () => {
    const s = { ...createDefaultSettings(), schemaVersion: 99 };
    expect(migrateSettings(s).schemaVersion).toBe(SCHEMA_VERSION.settings);
  });
});
