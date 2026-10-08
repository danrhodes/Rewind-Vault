import { Notice, Platform, Plugin } from "obsidian";
import { Actions, BusyFlag } from "./commands/actions";
import { MilestoneActions, buildMilestoneCommands } from "./commands/milestoneActions";
import { TextPromptModal } from "./ui/TextPromptModal";
import { buildRecoveryCommands, buildTimeMachineCommands } from "./timeMachine";
import { MaintenanceActions, buildMaintenanceCommands } from "./commands/maintenanceActions";
import { SettingsActions, buildSettingsCommands } from "./commands/settingsActions";
import { RestoreActions } from "./commands/restoreActions";
import { buildCommands } from "./commands/definitions";
import { registerCommands } from "./commands/register";
import { createPlatform } from "./helpers/platform";
import { createAutomation, type Automation } from "./automation";
import { createServices, type Services } from "./services";
import { migrateSettings } from "./settings/migrate";
import { RewindVaultSettingTab } from "./settings/SettingsTab";
import { createTextAppender } from "./storage/TextAppender";
import { AdapterVaultStore } from "./storage/VaultStore";
import { loadIndex } from "./core/BackupIndex";
import { BackupBrowserModal } from "./ui/BackupBrowserModal";
import { RestorePreviewModal } from "./ui/RestorePreviewModal";
import { DiffModal } from "./ui/DiffModal";
import { VerifyReportModal } from "./ui/VerifyReportModal";
import { QrModal } from "./ui/QrModal";
import { PassphraseModal } from "./ui/PassphraseModal";
import { LinkReportModal } from "./ui/LinkReportModal";
import { LinkChecker } from "./core/LinkReport";
import { ConfirmModal } from "./ui/ConfirmModal";
import { createProgressUi } from "./ui/progressHost";

/** Lifecycle only: load settings, build services, register things, clean up. */
export default class RewindVaultPlugin extends Plugin {
  private services: Services | null = null;
  private automation: Automation | null = null;

  override async onload(): Promise<void> {
    const settings = migrateSettings(await this.loadData());
    const store = new AdapterVaultStore(this.app.vault.adapter);
    const services = createServices({
      settings,
      store,
      appendText: createTextAppender(this.app.vault.adapter, store),
      platform: createPlatform({ isMobile: Platform.isMobile, isDesktop: Platform.isDesktop }),
      saveSettings: () => this.saveData(settings),
      pluginVersion: this.manifest.version,
      showNotice: (message, timeoutMs) => void new Notice(message, timeoutMs),
      promptPassphrase: () =>
        new PassphraseModal(
          this.app,
          "Backup passphrase",
          "Enter the passphrase for your encrypted backups.",
          false,
        ).ask(),
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
        links: new LinkChecker(services.store, services.getProfile),
        showLinkReport: (report) => new LinkReportModal(this.app, report).open(),
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
    const settingsActions = new SettingsActions({
      settings,
      platform: Platform.isMobile ? "mobile" : "desktop",
      showQr: (text) => new QrModal(this.app, text, (t) => navigator.clipboard.writeText(t)).open(),
      clipboard: {
        read: () => navigator.clipboard.readText(),
        write: (text) => navigator.clipboard.writeText(text),
      },
      confirm,
      askPassphrase: (title, message, repeat) =>
        new PassphraseModal(this.app, title, message, repeat).ask(),
      protectCopies: () => services.getProfile().misc.settingsPassphraseEnabled,
      save: () => this.saveData(settings),
      onChanged: () => automation.settingsChanged(),
      notifier: services.notifier,
    });
    const maintenance = new MaintenanceActions({
      admin: () => services.admin(),
      confirm,
      notifier: services.notifier,
      busy,
      massChange: automation.massChange,
      refreshStatusNote: services.refreshStatusNote,
    });
    const askName = (title: string, message: string) =>
      new TextPromptModal(this.app, title, message, "Name", "OK").ask();
    const milestones = new MilestoneActions({
      backupForMilestone: () => actions.backupForMilestone(),
      admin: () => services.admin(),
      askName,
      notifier: services.notifier,
    });
    const commands = buildCommands(
      actions,
      {
        openBackupBrowser: () =>
          new BackupBrowserModal(this.app, {
            loadIndex: () =>
              loadIndex(services.store, services.getProfile().destination.backupFolder),
            admin: () => services.admin(),
            askName,
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
                readBackupFile: (backupId, path) =>
                  services.restore.readFile({ id: backupId }, path),
                readLiveFile: (path) => services.store.readBinary(path),
                notifier: services.notifier,
              }).open(),
            confirm,
            notifier: services.notifier,
          }).open(),
      },
      [
        ...buildSettingsCommands(settingsActions),
        ...buildMaintenanceCommands(maintenance),
        ...buildTimeMachineCommands(this.app, services, restoreActions, confirm),
        ...buildRecoveryCommands(this.app, services, restoreActions),
        ...buildMilestoneCommands(milestones),
      ],
    );
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
