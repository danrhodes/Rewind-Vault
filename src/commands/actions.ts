import { loadIndex, sortedBackups } from "../core/BackupIndex";
import type { BackupEngine } from "../core/BackupEngine";
import type { RestoreProgress } from "../core/RestoreTypes";
import type { RunOptions, RunProgress } from "../core/RunTypes";
import { runOptionsForStyle } from "../core/RunStyle";
import type { VerifyOptions } from "../core/VerifyEngine";
import { CancelledError, InsufficientSpaceError, LockError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IVaultStore } from "../storage/VaultStore";
import type { SettingsProfile, VerifyLevel, VerifyReport } from "../types";
import type { Notifier } from "../ui/notify";
import { CancelSource } from "../ui/progressModel";

/** A progress dialog the action can update and close. Implemented by ProgressModal in main. */
export interface ProgressHandle {
  updateBackup(progress: RunProgress): void;
  updateRestore(progress: RestoreProgress): void;
  close(): void;
}

/**
 * One operation at a time across backups, verification and restores. Shared by Actions and
 * RestoreActions so a restore cannot start in the middle of a backup (and vice versa).
 */
export class BusyFlag {
  private busy = false;

  get isBusy(): boolean {
    return this.busy;
  }

  /** True if the caller now owns the flag and must `release()` it. */
  tryAcquire(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  release(): void {
    this.busy = false;
  }
}

export interface ProgressUi {
  open(title: string, cancel: CancelSource): ProgressHandle;
}

/** Screens the actions hand results to. Optional ones are added by later UI tasks. */
export interface ResultUi {
  showVerifyReport?(report: VerifyReport): void;
}

export interface ActionDeps {
  store: IVaultStore;
  logger: ILogger;
  backup: Pick<BackupEngine, "run" | "resume" | "findResumable">;
  verifyBackup: (backupId: string, options: VerifyOptions) => Promise<VerifyReport>;
  notifier: Notifier;
  getProfile: () => SettingsProfile;
  progress: ProgressUi;
  results?: ResultUi;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the commands do. One operation at a time: a second request while one is running is
 * refused with a message, so the palette, ribbon icon and triggers cannot pile up work.
 * Every outcome (done, cancelled, busy, failed) ends in a notice, never an unhandled error.
 */
export class Actions {
  constructor(
    private readonly deps: ActionDeps,
    private readonly flag: BusyFlag = new BusyFlag(),
  ) {}

  get isBusy(): boolean {
    return this.flag.isBusy;
  }

  /** "Backup now": the configured automatic style, or differential when that is "off". */
  backupNow(): Promise<void> {
    const style = this.deps.getProfile().basic.autoStyle;
    return this.runBackup(runOptionsForStyle(style) ?? { mode: "diff" }, false);
  }

  backupFull(): Promise<void> {
    return this.runBackup({ mode: "full" }, false);
  }

  backupDifferential(): Promise<void> {
    return this.runBackup({ mode: "diff" }, false);
  }

  backupNonDestructive(): Promise<void> {
    return this.runBackup({ mode: "diff", nonDestructive: true }, false);
  }

  /** Continue an interrupted backup, or tell the user there is none. */
  async resumeInterrupted(): Promise<void> {
    const info = await this.deps.backup.findResumable().catch(() => null);
    if (!info) {
      this.deps.notifier.info("There is no interrupted backup to resume.");
      return;
    }
    return this.runBackup({ mode: info.type }, true);
  }

  /** Verify the newest backup (any status, so a damaged one can be re-checked). */
  async verifyLatest(level: VerifyLevel): Promise<void> {
    await this.verifyOne(level, null);
  }

  /** Verify one chosen backup (from the backup browser). */
  async verifyById(backupId: string, level: VerifyLevel): Promise<void> {
    await this.verifyOne(level, backupId);
  }

  private async verifyOne(level: VerifyLevel, backupId: string | null): Promise<void> {
    const { notifier } = this.deps;
    if (!this.acquire()) return;
    try {
      let id = backupId;
      if (id === null) {
        const folder = this.deps.getProfile().destination.backupFolder;
        id = sortedBackups(await loadIndex(this.deps.store, folder))[0]?.id ?? null;
      }
      if (id === null) {
        notifier.info("There are no backups to verify yet.");
        return;
      }
      notifier.info(`Verifying ${id}…`);
      this.reportVerification(await this.deps.verifyBackup(id, { level }));
    } catch (error) {
      this.reportFailure("Verification", error);
    } finally {
      this.flag.release();
    }
  }

  private reportVerification(report: VerifyReport): void {
    const { notifier, results } = this.deps;
    if (results?.showVerifyReport) results.showVerifyReport(report);
    if (report.result === "fail") {
      notifier.error(
        `Backup ${report.backupId} FAILED verification at level ${report.level}: ${report.issues.length} problem(s).`,
      );
      return;
    }
    notifier.success(`Backup ${report.backupId} passed verification (level ${report.level}).`);
    if (report.skipped?.length)
      notifier.warning(`Some checks were skipped: ${report.skipped.join("; ")}`);
  }

  private async runBackup(options: RunOptions, resume: boolean): Promise<void> {
    const { notifier, backup, progress } = this.deps;
    if (!this.acquire()) return;
    const cancel = new CancelSource();
    const handle = progress.open(resume ? "Resuming backup" : "Backing up", cancel);
    try {
      const run = resume ? backup.resume.bind(backup) : backup.run.bind(backup);
      const result = await run({
        ...options,
        onProgress: (p) => handle.updateBackup(p),
        isCancelled: cancel.isCancelled,
      });
      notifier.backupResult(result);
    } catch (error) {
      this.reportFailure("Backup", error);
    } finally {
      handle.close();
      this.flag.release();
    }
  }

  private acquire(): boolean {
    if (!this.flag.tryAcquire()) {
      this.deps.notifier.warning("Another Rewind Vault operation is already running.");
      return false;
    }
    return true;
  }

  private reportFailure(action: string, error: unknown): void {
    const { notifier, logger } = this.deps;
    if (error instanceof CancelledError) {
      notifier.info(`${action} cancelled.`);
    } else if (error instanceof LockError) {
      notifier.warning(`${action} did not start: ${error.message}`);
    } else if (error instanceof InsufficientSpaceError) {
      notifier.error(
        `${action} stopped: not enough free space. Free some space or lower the minimum in settings.`,
      );
    } else {
      logger.error(`${action} failed: ${describe(error)}`);
      notifier.failure(action, error);
    }
  }
}
