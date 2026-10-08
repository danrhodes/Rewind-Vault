import type { BackupEngine } from "../core/BackupEngine";
import { runOptionsForStyle } from "../core/RunStyle";
import { LockError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { BackupStatusSink } from "../ui/StatusBar";
import type { Notifier } from "../ui/notify";
import type { SettingsProfile } from "../types";
import type { ConditionResult } from "./Conditions";
import type { RunProgress, RunResult } from "../core/RunTypes";
import type { ResumeInfo } from "../core/BackupEngine";
import type { RunRequest, TriggerReason } from "./TriggerTypes";

export interface AutoBackupDeps {
  backup: Pick<BackupEngine, "run"> & Partial<Pick<BackupEngine, "resume" | "findResumable">>;
  /** Battery, Wi-Fi, free space and no-change checks (see Conditions.ts). */
  /** `continuing` is true when finishing an interrupted backup rather than starting a new one. */
  conditions: (reason: TriggerReason, continuing: boolean) => Promise<ConditionResult>;
  notifier: Notifier;
  logger: ILogger;
  getProfile: () => SettingsProfile;
  /** Shared with the manual commands so an automatic run never overlaps a manual one. */
  busy: { tryAcquire(): boolean; release(): void };
  status?: BackupStatusSink;
  /** A reason to hold automatic backups back (mass-change guard), or null to go ahead. */
  hold?: () => string | null;
}

/**
 * What a trigger's request actually does: pick the configured automatic style, check the
 * conditions, run the engine, and report. Always used behind the RunGuard. A LockError is
 * rethrown for the guard to log quietly; every other failure is reported here (notice, log,
 * status bar) and swallowed so one failed run never stops later triggers.
 */
export function createAutoBackup(deps: AutoBackupDeps): RunRequest {
  return async (reason) => {
    const { logger, notifier, status } = deps;
    // A pre-risk snapshot is always a differential run, whatever the automatic style says
    // (even "off": the safety setting is separate).
    const options =
      reason === "pre-risk" || reason === "low-battery"
        ? ({ mode: "diff" } as const)
        : runOptionsForStyle(deps.getProfile().basic.autoStyle);
    if (!options) {
      logger.debug(`Automatic backup ("${reason}") ignored: automatic style is off`);
      return;
    }
    const held = deps.hold?.() ?? null;
    if (held) {
      logger.info(`Automatic backup ("${reason}") held back: ${held}`);
      return;
    }
    if (!deps.busy.tryAcquire()) {
      logger.debug(`Automatic backup ("${reason}") dropped: another operation is running`);
      return;
    }
    let ok = true;
    try {
      const interrupted = await findInterrupted(deps, reason);
      if (!(await deps.conditions(reason, interrupted !== null)).ok) return;
      const onProgress = (p: RunProgress): void => status?.progress(p);
      let result: RunResult;
      if (interrupted && deps.backup.resume) {
        logger.info(`Automatic backup continuing ${interrupted.backupId} (${reason})`);
        result = await deps.backup.resume({ mode: interrupted.type, onProgress });
      } else {
        logger.info(`Automatic backup started (${reason})`);
        result = await deps.backup.run({ ...options, onProgress });
      }
      notifier.backupResult(result);
    } catch (error) {
      if (error instanceof LockError) throw error;
      ok = false;
      logger.error(
        `Automatic backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      notifier.failure("Automatic backup", error);
    } finally {
      deps.busy.release();
      status?.finished(ok);
    }
  };
}

/**
 * An interrupted backup to carry on with, when this trigger is a startup or a return to the
 * foreground and the setting allows it. A lookup failure means "none": a fresh backup follows.
 */
async function findInterrupted(
  deps: AutoBackupDeps,
  reason: TriggerReason,
): Promise<ResumeInfo | null> {
  if (reason !== "startup" && reason !== "resume") return null;
  if (!deps.getProfile().triggers.continueInterrupted || !deps.backup.findResumable) return null;
  return deps.backup.findResumable().catch(() => null);
}
