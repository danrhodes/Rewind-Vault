import { WrongPassphraseError } from "../helpers/errors";
import { isProtectedLink, protectLink, unprotectLink } from "../settings/protect";
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
  /** Ask for a passphrase; null when cancelled. `repeat` asks for it twice (setting a new one). */
  askPassphrase(title: string, message: string, repeat: boolean): Promise<string | null>;
  /** The "protect copied settings with a passphrase" setting, read each time. */
  protectCopies(): boolean;
  save(): Promise<void>;
  /** Tell triggers and the status bar to re-read the settings. */
  onChanged(): void;
  notifier: Notifier;
}

/** Copy the settings to the clipboard as a link, and load them from one. */
export class SettingsActions {
  constructor(private readonly deps: SettingsActionDeps) {}

  async copyLink(): Promise<void> {
    if (this.deps.protectCopies()) return this.copyProtectedLink();
    const { notifier } = this.deps;
    try {
      await this.deps.clipboard.write(exportSettings(this.deps.settings));
      notifier.success("Settings link copied. It does not include your stored passphrase.");
    } catch (error) {
      notifier.failure("Copying the settings", error);
    }
  }

  /** Like copyLink, but encrypted with a passphrase chosen now. */
  async copyProtectedLink(): Promise<void> {
    const { notifier } = this.deps;
    try {
      const passphrase = await this.deps.askPassphrase(
        "Protect the settings link",
        "Choose a passphrase (at least 8 characters). You will need it to import the link. " +
          "It is not your backup passphrase.",
        true,
      );
      if (passphrase === null) return;
      await this.deps.clipboard.write(
        await protectLink(exportSettings(this.deps.settings), passphrase),
      );
      notifier.success("Protected settings link copied.");
    } catch (error) {
      notifier.failure("Copying the settings", error);
    }
  }

  /** The clipboard text as a plain link, asking for the passphrase if it is protected. */
  private async readLink(): Promise<string | null> {
    const text = await this.deps.clipboard.read();
    if (!isProtectedLink(text)) return text;
    const passphrase = await this.deps.askPassphrase(
      "Protected settings link",
      "Enter the passphrase this link was protected with.",
      false,
    );
    if (passphrase === null) return null;
    try {
      return await unprotectLink(text, passphrase);
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        this.deps.notifier.error("Wrong passphrase, or the link was altered.");
        return null;
      }
      throw error;
    }
  }

  async importFromClipboard(): Promise<void> {
    const { notifier } = this.deps;
    try {
      const text = await this.readLink();
      if (text === null) return;
      const result = importSettings(text);
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
      id: "copy-settings-protected",
      name: "Copy settings as a passphrase-protected link",
      icon: "lock",
      run: () => actions.copyProtectedLink(),
    },
    {
      id: "import-settings",
      name: "Import settings from the clipboard",
      icon: "clipboard-paste",
      run: () => actions.importFromClipboard(),
    },
  ];
}
