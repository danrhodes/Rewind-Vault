import { Platform, Plugin } from "obsidian";
import { createPlatform } from "./helpers/platform";
import { createServices, type Services } from "./services";
import { migrateSettings } from "./settings/migrate";
import { RewindVaultSettingTab } from "./settings/SettingsTab";
import { AdapterVaultStore } from "./storage/VaultStore";

/** Lifecycle only: load settings, build services, register things, clean up. */
export default class RewindVaultPlugin extends Plugin {
  private services: Services | null = null;

  override async onload(): Promise<void> {
    const settings = migrateSettings(await this.loadData());
    this.services = createServices({
      settings,
      store: new AdapterVaultStore(this.app.vault.adapter),
      platform: createPlatform({ isMobile: Platform.isMobile, isDesktop: Platform.isDesktop }),
      saveSettings: () => this.saveData(settings),
    });
    this.addSettingTab(
      new RewindVaultSettingTab(this.app, this, {
        settings,
        platform: Platform.isMobile ? "mobile" : "desktop",
        save: () => this.saveData(settings),
      }),
    );
    this.services.logger.info("Rewind Vault loaded");
    // Triggers, commands and UI are registered here by later tasks.
  }

  override onunload(): void {
    this.services?.passphrase.clear();
    this.services?.logger.info("Rewind Vault unloaded");
    this.services = null;
  }
}
