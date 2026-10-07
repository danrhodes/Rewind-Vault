import { Notice, Platform, Plugin } from "obsidian";
import { Actions } from "./commands/actions";
import { buildCommands } from "./commands/definitions";
import { registerCommands } from "./commands/register";
import { createPlatform } from "./helpers/platform";
import { createServices, type Services } from "./services";
import { migrateSettings } from "./settings/migrate";
import { RewindVaultSettingTab } from "./settings/SettingsTab";
import { AdapterVaultStore } from "./storage/VaultStore";
import { createProgressUi } from "./ui/progressHost";

/** Lifecycle only: load settings, build services, register things, clean up. */
export default class RewindVaultPlugin extends Plugin {
  private services: Services | null = null;

  override async onload(): Promise<void> {
    const settings = migrateSettings(await this.loadData());
    const services = createServices({
      settings,
      store: new AdapterVaultStore(this.app.vault.adapter),
      platform: createPlatform({ isMobile: Platform.isMobile, isDesktop: Platform.isDesktop }),
      saveSettings: () => this.saveData(settings),
      pluginVersion: this.manifest.version,
      showNotice: (message, timeoutMs) => void new Notice(message, timeoutMs),
    });
    this.services = services;

    this.addSettingTab(
      new RewindVaultSettingTab(this.app, this, {
        settings,
        platform: Platform.isMobile ? "mobile" : "desktop",
        save: () => this.saveData(settings),
      }),
    );

    const actions = new Actions({
      store: services.store,
      logger: services.logger,
      backup: services.backup,
      verifyBackup: services.verifyBackup,
      notifier: services.notifier,
      getProfile: services.getProfile,
      progress: createProgressUi(this.app),
    });
    const commands = buildCommands(actions, {
      // Replaced by the backup browser in a later task.
      openBackupBrowser: () => services.notifier.info("The backup browser is not available yet."),
    });
    registerCommands(this, commands, services.getProfile, () => actions.backupNow());

    services.logger.info("Rewind Vault loaded");
    // Triggers, the status bar and the remaining screens are wired by later tasks.
  }

  override onunload(): void {
    this.services?.passphrase.clear();
    this.services?.logger.info("Rewind Vault unloaded");
    this.services = null;
  }
}
