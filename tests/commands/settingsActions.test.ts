import { describe, expect, it } from "vitest";
import { SettingsActions, buildSettingsCommands } from "../../src/commands/settingsActions";
import { createDefaultProfile, createDefaultSettings } from "../../src/settings/defaults";
import { exportSettings } from "../../src/settings/transfer";
import { Notifier } from "../../src/ui/notify";

function setup(clipboardText = "", answer = true) {
  const settings = createDefaultSettings();
  settings.desktop.encryption.passphrase = "local";
  const notices: string[] = [];
  const log = { saved: 0, changed: 0, written: "", asked: 0 };
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

  it("offers two palette commands", () => {
    const commands = buildSettingsCommands(setup().actions);
    expect(commands.map((c) => c.id)).toEqual(["copy-settings", "import-settings"]);
  });
});
