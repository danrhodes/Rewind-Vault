import { describe, expect, it } from "vitest";
import { ENCRYPTION, LIMITS, SCHEMA_VERSION } from "../../src/constants";
import { createDefaultProfile, createDefaultSettings } from "../../src/settings/defaults";

describe("default settings", () => {
  it("carries the current schema version and both profiles", () => {
    const s = createDefaultSettings();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION.settings);
    expect(Object.keys(s).sort()).toEqual(["desktop", "mobile", "schemaVersion"]);
  });

  it("returns independent copies", () => {
    const a = createDefaultSettings();
    const b = createDefaultSettings();
    a.desktop.exclusions.globs.push("x");
    a.mobile.triggers.dailyTimes.push("09:00");
    expect(b.desktop.exclusions.globs).toEqual([]);
    expect(b.mobile.triggers.dailyTimes).toEqual([]);
    expect(a.desktop).not.toBe(a.mobile);
  });

  it.each(["desktop", "mobile"] as const)("%s defaults are safe and in range", (kind) => {
    const p = createDefaultProfile(kind);
    expect(p.basic.startupDelaySec).toBeGreaterThanOrEqual(0);
    expect(p.basic.startupDelaySec).toBeLessThanOrEqual(LIMITS.startupDelayMaxSec);
    expect(p.zip.compressionLevel).toBeGreaterThanOrEqual(LIMITS.compressionLevelMin);
    expect(p.zip.compressionLevel).toBeLessThanOrEqual(LIMITS.compressionLevelMax);
    expect(p.encryption.kdfIterations).toBeGreaterThanOrEqual(ENCRYPTION.minIterations);
    expect(p.encryption.enabled).toBe(false);
    expect(p.destination.destination).toBe("vault");
    expect(p.destination.backupFolder).toBe("backup");
    expect(p.retention.keepLast).toBeGreaterThanOrEqual(1);
    expect(p.safety.preRestoreSnapshot).toBe(true);
    expect(p.triggers.onClose).toBe(false);
  });

  it("mobile uses smaller zips, a battery floor and no status bar", () => {
    const d = createDefaultProfile("desktop");
    const m = createDefaultProfile("mobile");
    expect(m.zip.maxOutputZipMb).toBeLessThan(d.zip.maxOutputZipMb);
    expect(m.zip.maxSourceMbPerZip).toBeLessThan(d.zip.maxSourceMbPerZip);
    expect(m.misc.chunkSizeKb).toBeLessThan(d.misc.chunkSizeKb);
    expect(m.conditions.minBatteryPct).toBeGreaterThan(0);
    expect(m.notifications.statusBar).toBe(false);
    expect(d.notifications.statusBar).toBe(true);
  });
});
