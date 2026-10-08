import { describe, expect, it } from "vitest";
import { SettingsActions, buildSettingsCommands } from "../../src/commands/settingsActions";
import { createDefaultProfile, createDefaultSettings } from "../../src/settings/defaults";
import { isProtectedLink, protectLink } from "../../src/settings/protect";
import { exportSettings } from "../../src/settings/transfer";
import { Notifier } from "../../src/ui/notify";

function setup(
  clipboardText = "",
  answer = true,
  passphrase: string | null = null,
  protect = false,
  platform: "desktop" | "mobile" = "desktop",
) {
  const settings = createDefaultSettings();
  settings.desktop.encryption.passphrase = "local";
  const notices: string[] = [];
  const log = { saved: 0, changed: 0, written: "", asked: 0, passphraseAsked: 0 };
  const profile = createDefaultProfile("desktop");
  profile.notifications.level = "verbose";
  const shown: string[] = [];
  const actions = new SettingsActions({
    settings,
    platform,
    showQr: (text) => shown.push(text),
    clipboard: {
      read: async () => clipboardText,
      write: async (t) => {
        log.written = t;
      },
    },
    confirm: async () => {
      log.asked++;
      return answer;
    },
    protectCopies: () => protect,
    askPassphrase: async () => {
      log.passphraseAsked++;
      return passphrase;
    },
    save: async () => {
      log.saved++;
    },
    onChanged: () => {
      log.changed++;
    },
    notifier: new Notifier(
      (m) => notices.push(m),
      () => profile,
    ),
  });
  return { actions, settings, notices, log, shown };
}

describe("SettingsActions", () => {
  it("copies a link without the passphrase", async () => {
    const t = setup();
    await t.actions.copyLink();
    expect(t.log.written).toBe(exportSettings(t.settings));
    expect(t.notices.join()).toContain("copied");
  });

  it("imports after confirmation, saves, notifies the triggers, keeps the passphrase", async () => {
    const source = createDefaultSettings();
    source.desktop.retention.keepLast = 77;
    const t = setup(exportSettings(source));
    await t.actions.importFromClipboard();
    expect(t.log.asked).toBe(1);
    expect(t.settings.desktop.retention.keepLast).toBe(77);
    expect(t.settings.desktop.encryption.passphrase).toBe("local");
    expect(t.log).toMatchObject({ saved: 1, changed: 1 });
  });

  it("changes nothing when the user declines", async () => {
    const source = createDefaultSettings();
    source.desktop.retention.keepLast = 77;
    const t = setup(exportSettings(source), false);
    const before = t.settings.desktop.retention.keepLast;
    await t.actions.importFromClipboard();
    expect(t.settings.desktop.retention.keepLast).toBe(before);
    expect(t.log).toMatchObject({ saved: 0, changed: 0 });
  });

  it("reports a bad clipboard without asking or changing anything", async () => {
    const t = setup("not a link");
    await t.actions.importFromClipboard();
    expect(t.log.asked).toBe(0);
    expect(t.log.saved).toBe(0);
    expect(t.notices.join()).toContain("not a Rewind Vault settings link");
  });

  it("copies a protected link and imports it with the same passphrase", async () => {
    const source = createDefaultSettings();
    source.desktop.retention.keepLast = 55;
    const copier = setup("", true, "long enough pass");
    Object.assign(copier.settings, source);
    await copier.actions.copyProtectedLink();
    expect(isProtectedLink(copier.log.written)).toBe(true);

    const receiver = setup(copier.log.written, true, "long enough pass");
    await receiver.actions.importFromClipboard();
    expect(receiver.log.passphraseAsked).toBe(1);
    expect(receiver.settings.desktop.retention.keepLast).toBe(55);
  });

  it("does not import a protected link with the wrong passphrase", async () => {
    const copier = setup("", true, "long enough pass");
    await copier.actions.copyProtectedLink();
    const receiver = setup(copier.log.written, true, "another passphrase");
    await receiver.actions.importFromClipboard();
    expect(receiver.log).toMatchObject({ asked: 0, saved: 0 });
    expect(receiver.notices.join()).toContain("Wrong passphrase");
  });

  it("does nothing when the passphrase prompt is cancelled", async () => {
    const copier = setup("", true, null);
    await copier.actions.copyProtectedLink();
    expect(copier.log.written).toBe("");
    const protectedText = await protectLink("x", "long enough pass");
    const receiver = setup(protectedText, true, null);
    await receiver.actions.importFromClipboard();
    expect(receiver.log).toMatchObject({ asked: 0, saved: 0 });
  });

  it("copies a protected link from the plain command when the setting is on", async () => {
    const t = setup("", true, "long enough pass", true);
    await t.actions.copyLink();
    expect(isProtectedLink(t.log.written)).toBe(true);
    expect(t.log.passphraseAsked).toBe(1);
  });

  it("copies nothing when the setting is on and the passphrase prompt is cancelled", async () => {
    const t = setup("", true, null, true);
    await t.actions.copyLink();
    expect(t.log.written).toBe("");
  });

  it("shows a QR code for this device and imports it on another, replacing only that profile", async () => {
    const sender = setup("", true, null, false, "desktop");
    sender.settings.desktop.retention.keepLast = 77;
    sender.settings.desktop.encryption.passphrase = "never-sent";
    sender.actions.showQrCode();
    expect(sender.shown).toHaveLength(1);
    expect(sender.shown[0]?.startsWith("RVQ1:")).toBe(true);

    const phone = setup(sender.shown[0] ?? "", true, null, false, "mobile");
    phone.settings.desktop.retention.keepLast = 3; // must stay untouched
    phone.settings.mobile.encryption.passphrase = "phone-secret";
    await phone.actions.importFromClipboard();
    expect(phone.log.asked).toBe(1);
    expect(phone.settings.mobile.retention.keepLast).toBe(77);
    expect(phone.settings.desktop.retention.keepLast).toBe(3);
    expect(phone.settings.mobile.encryption.passphrase).toBe("phone-secret");
    expect(phone.log).toMatchObject({ saved: 1, changed: 1 });
  });

  it("tells the user when the settings are too different to fit in a QR code", () => {
    const t = setup();
    t.settings.desktop.exclusions.globs = Array.from(
      { length: 80 },
      (_, i) =>
        `${((i + 7) * 2654435761).toString(36)}${((i + 3) * 40503 * 97).toString(36)}-${(i * 7919 + 13).toString(36)}/`,
    );
    t.actions.showQrCode();
    expect(t.shown).toEqual([]);
    expect(t.notices.join()).toContain("settings link");
  });

  it("offers four palette commands", () => {
    const commands = buildSettingsCommands(setup().actions);
    expect(commands.map((c) => c.id)).toEqual([
      "copy-settings",
      "copy-settings-protected",
      "show-settings-qr",
      "import-settings",
    ]);
  });
});
