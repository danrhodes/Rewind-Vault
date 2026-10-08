import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../../src/settings/defaults";
import {
  MAX_TRANSFER_CHARS,
  TRANSFER_URI_PREFIX,
  applyImportedSettings,
  exportSettings,
  importSettings,
} from "../../src/settings/transfer";

function custom() {
  const s = createDefaultSettings();
  s.desktop.destination.backupFolder = "my-backups/é";
  s.desktop.retention.keepLast = 42;
  s.desktop.triggers.dailyTimes = ["03:30", "21:00"];
  s.mobile.zip.compressionLevel = 0;
  s.desktop.encryption.passphrase = "secret-desktop";
  s.mobile.encryption.passphrase = "secret-mobile";
  return s;
}

describe("settings transfer", () => {
  it("round-trips everything except the stored passphrases", () => {
    const original = custom();
    const link = exportSettings(original);
    expect(link.startsWith(TRANSFER_URI_PREFIX)).toBe(true);
    const result = importSettings(link);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = custom();
    expected.desktop.encryption.passphrase = "";
    expected.mobile.encryption.passphrase = "";
    expect(result.settings).toEqual(expected);
  });

  it("never puts a passphrase in the link", () => {
    const link = exportSettings(custom());
    const decoded = atob(
      link.slice(TRANSFER_URI_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/"),
    );
    expect(decoded).not.toContain("secret-desktop");
    expect(decoded).not.toContain("secret-mobile");
  });

  it("does not change the exported object", () => {
    const original = custom();
    exportSettings(original);
    expect(original.desktop.encryption.passphrase).toBe("secret-desktop");
  });

  it("accepts the link, the bare payload, and the JSON", () => {
    const link = exportSettings(custom());
    const bare = link.slice(TRANSFER_URI_PREFIX.length);
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(bare.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    );
    for (const text of [link, ` ${link}\n`, bare, json]) {
      const result = importSettings(text);
      expect(result.ok, text.slice(0, 20)).toBe(true);
    }
  });

  it("rejects garbage, the wrong format, the wrong version and oversized text", () => {
    expect(importSettings("hello world").ok).toBe(false);
    expect(importSettings("").ok).toBe(false);
    expect(importSettings('{"a":1}').ok).toBe(false);
    expect(importSettings('{"format":"rewind-vault-settings","version":99,"settings":{}}')).toEqual(
      {
        ok: false,
        error: "Unsupported settings link version 99.",
      },
    );
    expect(importSettings("x".repeat(MAX_TRANSFER_CHARS + 1)).ok).toBe(false);
    expect(importSettings("null").ok).toBe(false);
  });

  it("sanitises hostile values instead of trusting them", () => {
    const envelope = {
      format: "rewind-vault-settings",
      version: 1,
      settings: {
        schemaVersion: 1,
        desktop: {
          retention: { keepLast: -5 },
          encryption: { kdfIterations: 1 },
          evil: { x: 1 },
        },
      },
    };
    const result = importSettings(JSON.stringify(envelope));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.desktop.retention.keepLast).toBe(1);
    expect(result.settings.desktop.encryption.kdfIterations).toBeGreaterThanOrEqual(600_000);
    expect("evil" in result.settings.desktop).toBe(false);
    // Missing parts fall back to defaults.
    expect(result.settings.mobile).toEqual(createDefaultSettings().mobile);
  });

  it("applies imported settings in place and keeps the local passphrases", () => {
    const target = createDefaultSettings();
    target.desktop.encryption.passphrase = "local-secret";
    const reference = target;
    const imported = importSettings(exportSettings(custom()));
    if (!imported.ok) throw new Error("import failed");
    applyImportedSettings(target, imported.settings);
    expect(target).toBe(reference);
    expect(target.desktop.retention.keepLast).toBe(42);
    expect(target.desktop.encryption.passphrase).toBe("local-secret");
    expect(target.mobile.encryption.passphrase).toBe("");
  });
});
