import { describe, expect, it } from "vitest";
import { SettingsActions, buildSettingsCommands } from "../../src/commands/settingsActions";
import { createDefaultProfile, createDefaultSettings } from "../../src/settings/defaults";
import { isProtectedLink, protectLink } from "../../src/settings/protect";
import { exportSettings } from "../../src/settings/transfer";
import { Notifier } from "../../src/ui/notify";

function setup(clipboardText = "", answer = true, passphrase: string | null = null) {
  const settings = createDefaultSettings();
  settings.desktop.encryption.passphrase = "local";
  const notices: string[] = [];
  const log = { saved: 0, changed: 0, written: "", asked: 0, passphraseAsked: 0 };
  const profile = createDefaultProfile("desktop");
  profile.notifications.level = "verbose";
  const actions = new SettingsActions({
    settings,
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
  return { actions, settings, notices, log };
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

  it("offers three palette commands", () => {
    const commands = buildSettingsCommands(setup().actions);
    expect(commands.map((c) => c.id)).toEqual([
      "copy-settings",
      "copy-settings-protected",
      "import-settings",
    ]);
  });
});
