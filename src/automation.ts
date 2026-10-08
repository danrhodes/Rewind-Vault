import type { Plugin } from "obsidian";
import type { BusyFlag } from "./commands/actions";
import { loadIndex, sortedBackups } from "./core/BackupIndex";
import { isDeepVerifyDue, runDeepVerify } from "./core/DeepVerify";
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

export interface Automation {
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
  });
  const guard = new RunGuard({ clock, logger, run });

  const manager = new TriggerManager({
    triggers: { clock, logger, getProfile, run: guard.request },
    platform,
    timers: createTimerHost(plugin),
    events: createVaultEvents(plugin.app),
    close: createCloseEvents(),
    whenReady: (callback) => plugin.app.workspace.onLayoutReady(callback),
    lastBackupAt,
    deepVerify: {
      isDue: () => isDeepVerifyDue(services.verifyDeps),
      run: async () => {
        const report = await runDeepVerify(services.verifyDeps);
        if (report?.result === "fail" && getProfile().verification.onFailureNotify) {
          notifier.error(`Scheduled deep verify FAILED for ${report.backupId}. See the log.`);
        }
      },
    },
  });

  return {
    status,
    start(whenReady) {
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
      manager.stop();
      statusBar.dispose();
    },
  };
}
