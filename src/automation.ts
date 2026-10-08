import type { Plugin } from "obsidian";
import type { BusyFlag } from "./commands/actions";
import { loadIndex, sortedBackups } from "./core/BackupIndex";
import { MassChangeGuard } from "./core/MassChangeGuard";
import { PluginWatch } from "./core/PluginWatch";
import { isRehearsalDue, runScheduledRehearsal } from "./core/ScheduledRehearsal";
import { isDeepVerifyDue, runDeepVerify } from "./core/DeepVerify";
import { isInsideFolder } from "./helpers/glob";
import { createNetworkProbe } from "./helpers/network";
import {
  createCloseEvents,
  createStatusBarItem,
  createTimerHost,
  createVaultEvents,
} from "./obsidianHosts";
import type { Services } from "./services";
import { createStorageEstimateProbe } from "./storage/FreeSpace";
import { createAutoBackup } from "./triggers/AutoBackup";
import { evaluateConditions } from "./triggers/Conditions";
import { RunGuard } from "./triggers/RunGuard";
import { TriggerManager } from "./triggers/TriggerManager";
import { StatusBar, type BackupStatusSink } from "./ui/StatusBar";

/** The mass-change guard as the rest of the plugin sees it. */
export interface MassChangeControl {
  isPaused(): boolean;
  /** One sentence for the user about what tripped it. */
  summary(): string;
  /** The changes were intended: automatic backups may run again. */
  release(): void;
}

export interface Automation {
  readonly massChange: MassChangeControl;
  /** Mirrors backup progress into the status bar. Give it to the manual actions too. */
  readonly status: BackupStatusSink;
  /** Start the triggers and status bar. Call once, from onload. */
  start(whenReady: (callback: () => void) => void): void;
  /** Call after a setting changed. */
  settingsChanged(): void;
  stop(): void;
}

/** Connects triggers, run guard, conditions and status bar to the services and Obsidian. */
export function createAutomation(plugin: Plugin, services: Services, busy: BusyFlag): Automation {
  const { store, logger, clock, platform, notifier, getProfile } = services;
  const statusBar = new StatusBar({
    platform,
    clock,
    getProfile,
    createItem: () => createStatusBarItem(plugin),
  });

  const lastBackupAt = async (): Promise<number | null> => {
    const index = await loadIndex(store, getProfile().destination.backupFolder);
    return sortedBackups(index)[0]?.createdAt ?? null;
  };
  const showIdle = (): void => {
    lastBackupAt().then(
      (at) => statusBar.setIdle(at),
      () => statusBar.setIdle(null),
    );
  };
  const status: BackupStatusSink = {
    progress: (p) => statusBar.setProgress(p),
    finished: (ok) => (ok ? showIdle() : statusBar.setError()),
  };

  const massGuard = new MassChangeGuard(clock, () => {
    const safety = getProfile().safety;
    return {
      enabled: safety.massChangeGuard,
      threshold: safety.massChangeThreshold,
      windowSec: safety.massChangeWindowSec,
    };
  });
  const massChange: MassChangeControl = {
    isPaused: () => massGuard.isTripped,
    summary: () => {
      const trip = massGuard.tripInfo;
      return trip
        ? `${trip.files} files changed within ${trip.windowSec} seconds`
        : "no mass change detected";
    },
    release: () => massGuard.release(),
  };
  // Our own writes (backups, restores) and the backup folders must not count as vault changes.
  const onVaultChange = (path: string): void => {
    const { destination } = getProfile();
    if (busy.isBusy) return;
    if (
      isInsideFolder(path, destination.backupFolder) ||
      isInsideFolder(path, destination.restoreFolder)
    ) {
      return;
    }
    if (massGuard.record(path)) {
      logger.warn(`Mass change detected: ${massChange.summary()}. Automatic backups paused.`);
      notifier.error(
        `${massChange.summary()}. Automatic backups are paused so the last good backup is ` +
          'kept. If the changes are expected, run "Resume automatic backups".',
      );
      statusBar.setError();
    }
  };

  const freeSpace = createStorageEstimateProbe();
  const network = createNetworkProbe();
  const run = createAutoBackup({
    backup: services.backup,
    conditions: () =>
      evaluateConditions({ store, logger, platform, getProfile, freeSpace, network }),
    notifier,
    logger,
    getProfile,
    busy,
    status,
    hold: () => (massGuard.isTripped ? `mass change guard: ${massChange.summary()}` : null),
  });
  const guard = new RunGuard({
    clock,
    logger,
    run,
    bypassCooldown: ["close", "pre-risk"],
  });

  const vaultEvents = createVaultEvents(plugin.app);
  const manager = new TriggerManager({
    triggers: { clock, logger, getProfile, run: guard.request },
    platform,
    timers: createTimerHost(plugin),
    events: vaultEvents,
    close: createCloseEvents(),
    whenReady: (callback) => plugin.app.workspace.onLayoutReady(callback),
    lastBackupAt,
    plugins: new PluginWatch({
      store,
      logger,
      configDir: plugin.app.vault.configDir,
      backupFolder: () => getProfile().destination.backupFolder,
      selfId: plugin.manifest.id,
    }),
    rehearsal: {
      isDue: () => isRehearsalDue(services.verifyDeps, () => canDecryptUnattended(services)),
      run: async () => {
        const report = await runScheduledRehearsal(services.verifyDeps);
        await services.refreshStatusNote();
        if (report?.result === "fail" && getProfile().verification.onFailureNotify) {
          notifier.error(`Scheduled restore rehearsal FAILED for ${report.backupId}. See the log.`);
        }
      },
    },
    deepVerify: {
      isDue: () => isDeepVerifyDue(services.verifyDeps),
      run: async () => {
        const report = await runDeepVerify(services.verifyDeps);
        await services.refreshStatusNote();
        if (report?.result === "fail" && getProfile().verification.onFailureNotify) {
          notifier.error(`Scheduled deep verify FAILED for ${report.backupId}. See the log.`);
        }
      },
    },
  });

  let stopGuardEvents: (() => void)[] = [];
  return {
    status,
    massChange,
    start(whenReady) {
      stopGuardEvents = (["modify", "create", "delete", "rename"] as const).map((kind) =>
        vaultEvents.on(kind, onVaultChange),
      );
      whenReady(() => {
        showIdle();
        plugin.registerInterval(window.setInterval(() => statusBar.refresh(), 60_000));
      });
      manager.start();
    },
    settingsChanged() {
      manager.reconfigure();
      statusBar.refresh();
    },
    stop() {
      for (const off of stopGuardEvents) off();
      stopGuardEvents = [];
      manager.stop();
      statusBar.dispose();
    },
  };
}

/** A passphrase is stored or already cached, so no dialog will appear. */
function canDecryptUnattended(services: Services): boolean {
  return (
    services.getProfile().encryption.passphrase !== "" || services.passphrase.hasCachedPassphrase
  );
}
