import { Notice, Platform, Plugin } from "obsidian";
import { Actions, BusyFlag } from "./commands/actions";
import { RestoreActions } from "./commands/restoreActions";
import { buildCommands } from "./commands/definitions";
import { registerCommands } from "./commands/register";
import { createPlatform } from "./helpers/platform";
import { createAutomation, type Automation } from "./automation";
import { createServices, type Services } from "./services";
import { migrateSettings } from "./settings/migrate";
import { RewindVaultSettingTab } from "./settings/SettingsTab";
import { AdapterVaultStore } from "./storage/VaultStore";
import { loadIndex } from "./core/BackupIndex";
import { BackupBrowserModal } from "./ui/BackupBrowserModal";
import { RestorePreviewModal } from "./ui/RestorePreviewModal";
import { DiffModal } from "./ui/DiffModal";
import { VerifyReportModal } from "./ui/VerifyReportModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import { createProgressUi } from "./ui/progressHost";

/** Lifecycle only: load settings, build services, register things, clean up. */
export default class RewindVaultPlugin extends Plugin {
  private services: Services | null = null;
  private automation: Automation | null = null;

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
        onChanged: () => this.automation?.settingsChanged(),
      }),
    );

    const busy = new BusyFlag();
    const automation = createAutomation(this, services, busy);
    this.automation = automation;
    const progress = createProgressUi(this.app);
    const confirm = (title: string, message: string, label: string, dangerous: boolean) =>
      new ConfirmModal(this.app, title, message, label, dangerous).ask();
    const restoreActions = new RestoreActions(
      {
        restore: services.restore,
        notifier: services.notifier,
        logger: services.logger,
        progress,
      },
      busy,
    );
    const actions = new Actions(
      {
        store: services.store,
        logger: services.logger,
        backup: services.backup,
        verifyBackup: services.verifyBackup,
        notifier: services.notifier,
        getProfile: services.getProfile,
        progress,
        status: automation.status,
        results: {
          showVerifyReport: (report) =>
            new VerifyReportModal(this.app, report, (text) =>
              navigator.clipboard.writeText(text),
            ).open(),
        },
      },
      busy,
    );
    const commands = buildCommands(actions, {
      openBackupBrowser: () =>
        new BackupBrowserModal(this.app, {
          loadIndex: () =>
            loadIndex(services.store, services.getProfile().destination.backupFolder),
          admin: () => services.admin(),
          verify: (id) => actions.verifyById(id, 3),
          restore: (id, createdAt) =>
            new RestorePreviewModal(this.app, id, createdAt, {
              actions: restoreActions,
              snapshotEnabled: () => services.getProfile().safety.preRestoreSnapshot,
              confirm,
            }).open(),
          compare: (id, createdAt) =>
            new DiffModal(this.app, id, createdAt, {
              compare: (backupId) =>
                services.restore.preview({
                  source: { id: backupId },
                  scope: { kind: "all" },
                  destination: { kind: "vault" },
                  deleteExtraneous: true,
                }),
              readBackupFile: (backupId, path) => services.restore.readFile({ id: backupId }, path),
              readLiveFile: (path) => services.store.readBinary(path),
              notifier: services.notifier,
            }).open(),
          confirm,
          notifier: services.notifier,
        }).open(),
    });
    registerCommands(this, commands, services.getProfile, () => actions.backupNow());

    services.logger.info("Rewind Vault loaded");
    automation.start((callback) => this.app.workspace.onLayoutReady(callback));
  }

  override onunload(): void {
    this.automation?.stop();
    this.automation = null;
    this.services?.passphrase.clear();
    this.services?.logger.info("Rewind Vault unloaded");
    this.services = null;
  }
}
