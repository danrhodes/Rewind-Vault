import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../../src/settings/defaults";
import { resolveProfile, resolveProfileFor } from "../../src/settings/profiles";
import { MockPlatform } from "../mocks/MockPlatform";

describe("resolveProfile", () => {
  it("picks the profile for the platform", () => {
    const s = createDefaultSettings();
    s.desktop.zip.compressionLevel = 9;
    s.mobile.zip.compressionLevel = 1;
    expect(resolveProfile(s, "desktop").zip.compressionLevel).toBe(9);
    expect(resolveProfile(s, "mobile").zip.compressionLevel).toBe(1);
  });

  it("returns a copy, not a reference into settings", () => {
    const s = createDefaultSettings();
    const p = resolveProfile(s, "desktop");
    p.exclusions.globs.push("x");
    p.basic.autoStyle = "off";
    expect(s.desktop.exclusions.globs).toEqual([]);
    expect(s.desktop.basic.autoStyle).toBe("differential");
  });

  it("forces desktop-only features off on mobile", () => {
    const s = createDefaultSettings();
    s.mobile.destination.destination = "external";
    s.mobile.triggers.onClose = true;
    s.mobile.notifications.statusBar = true;
    const p = resolveProfile(s, "mobile");
    expect(p.destination.destination).toBe("vault");
    expect(p.triggers.onClose).toBe(false);
    expect(p.notifications.statusBar).toBe(false);
    expect(s.mobile.destination.destination).toBe("external");
  });

  it("leaves desktop-only features alone on desktop", () => {
    const s = createDefaultSettings();
    s.desktop.destination.destination = "external";
    s.desktop.triggers.onClose = true;
    const p = resolveProfile(s, "desktop");
    expect(p.destination.destination).toBe("external");
    expect(p.triggers.onClose).toBe(true);
  });

  it("resolveProfileFor follows the platform object", () => {
    const s = createDefaultSettings();
    s.mobile.conditions.minBatteryPct = 33;
    expect(resolveProfileFor(s, new MockPlatform("mobile")).conditions.minBatteryPct).toBe(33);
    expect(resolveProfileFor(s, new MockPlatform("desktop")).conditions.minBatteryPct).toBe(0);
  });
});

describe("mobile profile defaults (T-153)", () => {
  it("has no status bar, no external copy and the lighter limits", () => {
    const s = createDefaultSettings();
    const p = resolveProfile(s, "mobile");
    expect(p.notifications.statusBar).toBe(false);
    expect(p.destination.destination).toBe("vault");
    expect(p.zip.maxSourceMbPerZip).toBeLessThan(s.desktop.zip.maxSourceMbPerZip);
    expect(p.misc.keepAwake).toBe(true);
    expect(p.conditions.lowBatteryFlush).toBe(true);
  });

  it("turns compression off in low-memory mode and leaves it alone otherwise", () => {
    const s = createDefaultSettings();
    expect(resolveProfile(s, "mobile").zip.compressionLevel).toBe(6);
    s.mobile.misc.lowMemoryMode = true;
    expect(resolveProfile(s, "mobile").zip.compressionLevel).toBe(0);
    expect(s.mobile.zip.compressionLevel).toBe(6);
  });

  it("keeps the desktop profile untouched by mobile limits", () => {
    const s = createDefaultSettings();
    s.mobile.misc.lowMemoryMode = true;
    expect(resolveProfile(s, "desktop").zip.compressionLevel).toBe(6);
  });
});
