import { applyImportedSettings, exportSettings, importSettings } from "../settings/transfer";
import type { Settings } from "../types";
import type { Notifier } from "../ui/notify";
import type { CommandDef } from "./definitions";

export interface SettingsActionDeps {
  settings: Settings;
  clipboard: { read(): Promise<string>; write(text: string): Promise<void> };
  confirm(
    title: string,
    message: string,
    confirmLabel: string,
    dangerous: boolean,
  ): Promise<boolean>;
  save(): Promise<void>;
  /** Tell triggers and the status bar to re-read the settings. */
  onChanged(): void;
  notifier: Notifier;
}

/** Copy the settings to the clipboard as a link, and load them from one. */
export class SettingsActions {
  constructor(private readonly deps: SettingsActionDeps) {}

  async copyLink(): Promise<void> {
    const { notifier } = this.deps;
    try {
      await this.deps.clipboard.write(exportSettings(this.deps.settings));
      notifier.success("Settings link copied. It does not include your stored passphrase.");
    } catch (error) {
      notifier.failure("Copying the settings", error);
    }
  }

  async importFromClipboard(): Promise<void> {
    const { notifier } = this.deps;
    try {
      const result = importSettings(await this.deps.clipboard.read());
      if (!result.ok) {
        notifier.error(result.error);
        return;
      }
      const ok = await this.deps.confirm(
        "Import settings",
        "Replace ALL desktop and mobile settings with the ones on the clipboard? " +
          "Your stored passphrase is kept. This cannot be undone.",
        "Import",
        true,
      );
      if (!ok) return;
      applyImportedSettings(this.deps.settings, result.settings);
      await this.deps.save();
      this.deps.onChanged();
      notifier.success("Settings imported.");
    } catch (error) {
      notifier.failure("Importing the settings", error);
    }
  }
}

export function buildSettingsCommands(actions: SettingsActions): CommandDef[] {
  return [
    {
      id: "copy-settings",
      name: "Copy settings as a link",
      icon: "copy",
      run: () => actions.copyLink(),
    },
    {
      id: "import-settings",
      name: "Import settings from the clipboard",
      icon: "clipboard-paste",
      run: () => actions.importFromClipboard(),
    },
  ];
}
