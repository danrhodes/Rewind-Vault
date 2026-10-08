import { FILE_NAMES } from "./constants";
import { BackupAdmin } from "./core/BackupAdmin";
import { BackupEngine } from "./core/BackupEngine";
import { updateStatusNote } from "./core/StatusNote";
import { BackupMirror } from "./core/BackupMirror";
import { ExternalCopy, loadNodeFs, type ExternalFs } from "./storage/ExternalCopy";
import { RestoreEngine } from "./core/RestoreEngine";
import { verifyAndRecord, type VerifyRunnerDeps } from "./core/VerifyRunner";
import type { VerifyOptions } from "./core/VerifyEngine";
import { PassphraseService, type PassphrasePrompt } from "./crypto/passphrase";
import type { ILogger } from "./helpers/logger";
import { Logger, RotatingFileSink } from "./helpers/logger";
import type { IPlatform } from "./helpers/platform";
import { systemClock, type IClock } from "./helpers/time";
import { resolveProfileFor } from "./settings/profiles";
import { createStorageEstimateProbe, type IFreeSpaceProbe } from "./storage/FreeSpace";
import type { IVaultStore } from "./storage/VaultStore";
import { FailureAlert } from "./core/FailureAlert";
import type { ITextAppender } from "./storage/TextAppender";
import { Notifier, type ShowNotice } from "./ui/notify";
import type { Settings, SettingsProfile, VerifyReport } from "./types";

/**
 * The object UI, commands and triggers receive. Engines never reach for globals:
 * everything they need is passed in from here (PLAN section 3).
 */
export interface Services {
  readonly store: IVaultStore;
  readonly logger: ILogger;
  readonly clock: IClock;
  readonly platform: IPlatform;
  /** Passphrase cache and prompt. Call `passphrase.clear()` on unload. */
  readonly passphrase: PassphraseService;
  /** Raw settings for both profiles. Edited by the settings tab. */
  readonly settings: Settings;
  readonly backup: Pick<BackupEngine, "run" | "resume" | "findResumable">;
  readonly restore: RestoreEngine;
  /** Manual pin/delete of existing backups. A fresh instance, so it always sees current settings. */
  admin(): BackupAdmin;
  /** Notices honouring the notification level. */
  readonly notifier: Notifier;
  /** Verify an existing backup under the backup lock and record the result (marks corrupt on failure). */
  verifyBackup(backupId: string, options: VerifyOptions): Promise<VerifyReport>;
  /** What verification and deep verify need; used by the scheduler. */
  readonly verifyDeps: VerifyRunnerDeps;
  /** Rewrite the backup status note now (does nothing while the setting is off). */
  refreshStatusNote(): Promise<boolean>;
  /** Effective settings for this platform. Re-read after settings change. */
  getProfile(): SettingsProfile;
  saveSettings(): Promise<void>;
}

export interface ServiceDeps {
  settings: Settings;
  store: IVaultStore;
  platform: IPlatform;
  saveSettings: () => Promise<void>;
  clock?: IClock;
  /** Shows the passphrase dialog. Until the UI task supplies one, prompting is treated as cancelled. */
  promptPassphrase?: PassphrasePrompt;
  /** Plugin version written into manifests. Defaults to 0.0.0 (tests). */
  pluginVersion?: string;
  /** Shows a transient message; main passes `new Notice`. Defaults to doing nothing. */
  showNotice?: ShowNotice;
  /** Node fs for the external copy. Defaults to the runtime's (desktop); null disables it. */
  externalFs?: ExternalFs | null;
  /** Writes failure alerts into a note. Defaults to none (alerts are skipped). */
  appendText?: ITextAppender;
  /** Free-space probe for the pre-run check. Defaults to the browser storage estimate. */
  freeSpace?: IFreeSpaceProbe;
  /** Supply to replace the default file logger (tests). */
  logger?: ILogger;
}

export function createServices(deps: ServiceDeps): Services {
  const clock = deps.clock ?? systemClock;
  const { settings, store, platform } = deps;

  const logger = deps.logger ?? createFileLogger(deps, clock);

  const passphrase = new PassphraseService(
    () => {
      const e = resolveProfileFor(settings, platform).encryption;
      return {
        sessionCache: e.sessionCache,
        promptOnDemand: e.promptOnDemand,
        storedPassphrase: e.passphrase,
      };
    },
    deps.promptPassphrase ?? (async () => null),
  );

  const getProfile = (): SettingsProfile => resolveProfileFor(settings, platform);
  const deriveMasterKey = (salt: Uint8Array, iterations: number): Promise<Uint8Array> =>
    passphrase.getKey(salt, iterations);

  const verifyDeps: VerifyRunnerDeps = {
    store,
    logger,
    clock,
    getProfile,
    platform: platform.kind,
    deriveMasterKey,
  };

  const failureAlert = deps.appendText
    ? new FailureAlert(deps.appendText, clock, logger, () => getProfile().notifications)
    : null;

  const engine = new BackupEngine({
    store,
    logger,
    clock,
    getProfile,
    platform: platform.kind,
    pluginVersion: deps.pluginVersion ?? "0.0.0",
    deriveMasterKey,
    freeSpace: deps.freeSpace ?? createStorageEstimateProbe(),
  });

  // Desktop only: Node's fs, found at run time. Null on mobile, so no copy is ever attempted.
  const nodeFs = deps.externalFs === undefined ? loadNodeFs() : deps.externalFs;
  const refreshStatusNote = (): Promise<boolean> =>
    updateStatusNote({ store, logger, clock, getProfile });

  const backup = new BackupMirror({
    afterRun: refreshStatusNote,
    engine,
    copier: platform.isDesktop && nodeFs ? new ExternalCopy(store, nodeFs, logger) : null,
    platform,
    logger,
    getProfile,
    store,
  });

  const restore = new RestoreEngine({
    store,
    logger,
    clock,
    getProfile,
    deriveMasterKey,
    // A restore into the vault is preceded by a differential backup of the live vault.
    safetySnapshot: async () => {
      const result = await backup.run({ mode: "diff" });
      return result.status === "completed" ? { backupId: result.backupId } : null;
    },
  });

  return {
    store,
    logger,
    clock,
    platform,
    passphrase,
    settings,
    backup,
    restore,
    admin: () => {
      const profile = getProfile();
      return new BackupAdmin({
        store,
        logger,
        clock,
        backupFolder: profile.destination.backupFolder,
        lockTimeoutMin: profile.safety.lockTimeoutMin,
        platform: platform.kind,
      });
    },
    notifier: new Notifier(deps.showNotice ?? (() => undefined), getProfile, (message) => {
      void failureAlert?.report(message);
    }),
    verifyBackup: async (backupId, options) => {
      const report = await verifyAndRecord(verifyDeps, backupId, options);
      await refreshStatusNote();
      return report;
    },
    refreshStatusNote,
    verifyDeps,
    getProfile,
    saveSettings: deps.saveSettings,
  };
}

function createFileLogger(deps: ServiceDeps, clock: IClock): Logger {
  const profile = resolveProfileFor(deps.settings, deps.platform);
  const folder = profile.destination.backupFolder;
  const sink = new RotatingFileSink(
    deps.store,
    `${folder}/${FILE_NAMES.log}`,
    profile.notifications.logSizeCapKb * 1024,
  );
  const level = profile.notifications.level === "verbose" ? "debug" : "info";
  return new Logger(sink, level, () => clock.now());
}
