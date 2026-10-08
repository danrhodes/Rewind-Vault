import { describe, expect, it } from "vitest";
import { encodeQr } from "../../src/helpers/qr";
import { createDefaultSettings } from "../../src/settings/defaults";
import { QR_PREFIX, buildQrPayload, parseQrPayload } from "../../src/settings/qrTransfer";
import { applyImportedSettings } from "../../src/settings/transfer";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("buildQrPayload", () => {
  it("is tiny for default settings and always fits a QR code", () => {
    const result = buildQrPayload(createDefaultSettings(), "desktop");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith(QR_PREFIX)).toBe(true);
    expect(result.text.length).toBeLessThan(60);
    expect(() => encodeQr(bytes(result.text))).not.toThrow();
  });

  it("carries only what differs from the defaults, and never the passphrase", () => {
    const s = createDefaultSettings();
    s.desktop.retention.keepLast = 42;
    s.desktop.triggers.dailyTimes = ["03:30"];
    s.desktop.encryption.passphrase = "secret-value";
    const result = buildQrPayload(s, "desktop");
    if (!result.ok) throw new Error("expected a payload");
    expect(result.text).not.toContain("secret-value");
    const back = parseQrPayload(result.text, "desktop");
    expect(back.ok && back.settings.desktop.retention.keepLast).toBe(42);
    expect(back.ok && back.settings.desktop.triggers.dailyTimes).toEqual(["03:30"]);
    expect(back.ok && back.settings.desktop.encryption.passphrase).toBe("");
  });

  it("a realistically customised profile fits a QR code and encodes", () => {
    const s = createDefaultSettings();
    s.desktop.destination.backupFolder = "Backups/Rewind";
    s.desktop.exclusions.globs = ["Templates/", "*.tmp", "Private/**"];
    s.desktop.triggers.intervalMinutes = 45;
    s.desktop.retention.keepLast = 25;
    s.desktop.retention.gfsEnabled = true;
    s.desktop.notifications.level = "verbose";
    const result = buildQrPayload(s, "desktop");
    if (!result.ok) throw new Error("expected a payload");
    expect(() => encodeQr(bytes(result.text))).not.toThrow();
  });

  it("reports settings that are too different to fit", () => {
    const s = createDefaultSettings();
    s.desktop.exclusions.globs = Array.from(
      { length: 80 },
      (_, i) =>
        `${((i + 7) * 2654435761).toString(36)}${((i + 3) * 40503 * 97).toString(36)}-${(i * 7919 + 13).toString(36)}/`,
    );
    const result = buildQrPayload(s, "desktop");
    expect(result.ok).toBe(false);
  });
});

describe("parseQrPayload", () => {
  it("applies a desktop code to a phone on top of the PHONE defaults, for the phone profile only", () => {
    const desktop = createDefaultSettings();
    desktop.desktop.retention.keepLast = 77;
    const payload = buildQrPayload(desktop, "desktop");
    if (!payload.ok) throw new Error("expected a payload");
    const parsed = parseQrPayload(payload.text, "mobile");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scope).toBe("mobile");
    expect(parsed.settings.mobile.retention.keepLast).toBe(77);
    // The phone's own defaults (low battery limit) are not replaced by the desktop's.
    expect(parsed.settings.mobile.conditions.minBatteryPct).toBe(
      createDefaultSettings().mobile.conditions.minBatteryPct,
    );

    const target = createDefaultSettings();
    target.desktop.retention.keepLast = 5;
    target.mobile.encryption.passphrase = "keep-me";
    applyImportedSettings(target, parsed.settings, parsed.scope);
    expect(target.mobile.retention.keepLast).toBe(77);
    expect(target.desktop.retention.keepLast).toBe(5);
    expect(target.mobile.encryption.passphrase).toBe("keep-me");
  });

  it("rejects anything else without throwing", () => {
    for (const bad of [
      "",
      "hello",
      "RVQ1:",
      "RVQ1:!!!!",
      "RVQ1:AAAA",
      `${QR_PREFIX}${"A".repeat(40)}`,
    ]) {
      expect(parseQrPayload(bad, "desktop").ok, bad).toBe(false);
    }
  });

  it("sanitises hostile values like any import", () => {
    // deflate of {"v":1,"p":"desktop","d":{"retention":{"keepLast":-9},"evil":{"x":1}}}
    const hostile = buildQrPayload(createDefaultSettings(), "desktop");
    if (!hostile.ok) throw new Error("setup");
    const s = createDefaultSettings();
    s.desktop.retention.keepLast = -9;
    const payload = buildQrPayload(s, "desktop");
    if (!payload.ok) throw new Error("expected a payload");
    const parsed = parseQrPayload(payload.text, "desktop");
    expect(parsed.ok && parsed.settings.desktop.retention.keepLast).toBe(1);
  });
});
