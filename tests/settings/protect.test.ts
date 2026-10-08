import { describe, expect, it } from "vitest";
import { toBase64 } from "../../src/helpers/bytes";
import { ConfigError, WrongPassphraseError } from "../../src/helpers/errors";
import { createDefaultSettings } from "../../src/settings/defaults";
import {
  PROTECTED_URI_PREFIX,
  isProtectedLink,
  protectLink,
  unprotectLink,
} from "../../src/settings/protect";
import { exportSettings, importSettings } from "../../src/settings/transfer";

const PASS = "correct horse battery";

describe("protected settings links", () => {
  it("round-trips a settings link with the right passphrase", async () => {
    const settings = createDefaultSettings();
    settings.desktop.retention.keepLast = 33;
    const link = exportSettings(settings);
    const protectedLink = await protectLink(link, PASS);
    expect(isProtectedLink(protectedLink)).toBe(true);
    expect(isProtectedLink(link)).toBe(false);
    expect(protectedLink).not.toContain("retention");
    const back = await unprotectLink(` ${protectedLink}\n`, PASS);
    expect(back).toBe(link);
    const imported = importSettings(back);
    expect(imported.ok && imported.settings.desktop.retention.keepLast).toBe(33);
  });

  it("uses a fresh salt every time", async () => {
    const a = await protectLink("x", PASS);
    const b = await protectLink("x", PASS);
    expect(a).not.toBe(b);
  });

  it("reports a wrong passphrase without crashing", async () => {
    const protectedLink = await protectLink("secret", PASS);
    await expect(unprotectLink(protectedLink, "wrong passphrase!")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it("detects altered data", async () => {
    const protectedLink = await protectLink("secret", PASS);
    const payload = protectedLink.slice(PROTECTED_URI_PREFIX.length);
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      data: string;
    };
    const bytes = Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    json.data = toBase64(bytes);
    const forged =
      PROTECTED_URI_PREFIX +
      btoa(JSON.stringify(json)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(unprotectLink(forged, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("rejects short passphrases, non-links and damaged links", async () => {
    await expect(protectLink("x", "short")).rejects.toBeInstanceOf(ConfigError);
    await expect(unprotectLink("hello", PASS)).rejects.toBeInstanceOf(ConfigError);
    await expect(unprotectLink(PROTECTED_URI_PREFIX + "%%%", PASS)).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("refuses a link that asks for too few or absurdly many iterations", async () => {
    const forge = (iterations: number) =>
      PROTECTED_URI_PREFIX +
      btoa(JSON.stringify({ v: 1, salt: "AAAA", iterations, data: "AAAA" }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    await expect(unprotectLink(forge(1000), PASS)).rejects.toBeInstanceOf(ConfigError);
    await expect(unprotectLink(forge(2_000_000_000), PASS)).rejects.toBeInstanceOf(ConfigError);
  });
});
