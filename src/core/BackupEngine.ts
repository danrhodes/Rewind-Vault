import { SCHEMA_VERSION } from "../constants";
import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { fromBase64 } from "../helpers/bytes";
import { CancelledError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { createYielder } from "../helpers/yieldToUI";
import { assertFreeSpace, estimateBackupBytes, type IFreeSpaceProbe } from "../storage/FreeSpace";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupState, BackupType, PlatformKind, SettingsProfile } from "../types";
import { findBackup, loadIndex } from "./BackupIndex";
import { loadCheckpoint } from "./Checkpoint";
import { executePlan, skipUnchanged, type ExecContext } from "./BackupExecutor";
import { planBackup, type RunPlan } from "./BackupPlanner";
import { loadState } from "./BackupState";
import { emptyState } from "./Differ";
import { LockManager, type LockOptions } from "./LockManager";
import { guardStore } from "./NonDestructiveGuard";
import { RunControl } from "./RunControl";
import { cleanUpFailedRun, discardUnfinished, usableCheckpoint } from "./UnfinishedRuns";
import type { RunOptions, RunResult } from "./RunTypes";

export type { RunOptions, RunProgress, RunResult } from "./RunTypes";

export interface EngineDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
  platform: PlatformKind;
  pluginVersion: string;
  /** PBKDF2 master key for a salt. Wired to PassphraseService.getKey in services. */
  deriveMasterKey: (salt: Uint8Array, iterations: number) => Promise<Uint8Array>;
  /** When set, a run is refused if free space is below the output estimate plus the reserve. */
  freeSpace?: IFreeSpaceProbe;
  /** Test seams. */
  yieldIfNeeded?: () => Promise<void>;
  lockOptions?: Partial<LockOptions>;
}

/** An interrupted backup that `resume()` can continue. */
export interface ResumeInfo {
  backupId: string;
  type: BackupType;
  partsDone: number;
  partsTotal: number;
  savedAt: number;
}

export class BackupEngine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Run one backup. Resolves with the result, or throws: CancelledError when cancelled,
   * LockError when another run is active, anything else on failure. Whatever the outcome,
   * a half-made backup folder is removed, the lock is released, and previous backups,
   * the index and the state are left as they were. An unfinished run left behind by a
   * crash is discarded first (use `resume()` to continue it instead).
   */
  run(options: RunOptions): Promise<RunResult> {
    return this.runInternal(options, false);
  }

  /**
   * Continue the interrupted backup recorded in checkpoint.json. If there is none, or its
   * parts no longer match, the leftovers are discarded and a fresh backup is made using
   * `options.mode`.
   */
  resume(options: RunOptions): Promise<RunResult> {
    return this.runInternal(options, true);
  }

  /** Describes a resumable backup without touching anything, or null when there is none. */
  async findResumable(): Promise<ResumeInfo | null> {
    const backupFolder = this.deps.getProfile().destination.backupFolder;
    const cp = await loadCheckpoint(this.deps.store, backupFolder);
    if (!cp) return null;
    const index = await loadIndex(this.deps.store, backupFolder);
    if (findBackup(index, cp.plan.id)) return null;
    if (!(await this.deps.store.exists(`${backupFolder}/${cp.plan.folder}`))) return null;
    return {
      backupId: cp.plan.id,
      type: cp.plan.type,
      partsDone: cp.nextPartIndex,
      partsTotal: cp.plan.parts.length,
      savedAt: cp.savedAt,
    };
  }

  private async runInternal(options: RunOptions, wantResume: boolean): Promise<RunResult> {
    const { logger, clock } = this.deps;
    const profile = this.deps.getProfile();
    const backupFolder = profile.destination.backupFolder;

    const candidate = wantResume ? await loadCheckpoint(this.deps.store, backupFolder) : null;
    const store = options.nonDestructive
      ? guardStore(
          this.deps.store,
          backupFolder,
          await this.existingBackupFolders(backupFolder, candidate?.plan.folder),
        )
      : this.deps.store;
    const control = new RunControl(options.onProgress, options.isCancelled);

    const lock = new LockManager(store, backupFolder, clock, {
      timeoutMin: profile.safety.lockTimeoutMin,
      platform: this.deps.platform,
      ...this.deps.lockOptions,
    });
    await lock.acquire();

    let createdFolder: string | null = null;
    try {
      control.update({ phase: "scanning" });
      control.assertNotCancelled();
      const index = await loadIndex(store, backupFolder);
      const resume = wantResume
        ? await usableCheckpoint(store, logger, backupFolder, index)
        : await discardUnfinished(store, logger, backupFolder, index).then(() => null);
      const state = await this.loadStateOrNull(backupFolder);

      let plan: RunPlan;
      if (resume) {
        plan = resume.plan;
      } else {
        const outcome = await planBackup({
          store,
          profile,
          requested: options.mode,
          now: clock.now(),
          index,
          state,
          yieldIfNeeded: this.deps.yieldIfNeeded,
        });
        if (outcome.noChanges && profile.conditions.skipIfNoChanges && state) {
          await skipUnchanged(store, backupFolder, outcome.plan, state, clock.now());
          logger.info("Nothing changed since the last backup: skipped");
          return { status: "skipped", reason: "no-changes" };
        }
        plan = outcome.plan;
      }
      control.assertNotCancelled();
      this.announce(plan, resume !== null);
      control.update({
        partCount: plan.parts.length,
        filesTotal: plan.parts.flat().length,
        bytesTotal: plan.totalBytes,
      });

      await this.checkSpace(plan, profile, resume?.nextPartIndex ?? 0);

      createdFolder = `${backupFolder}/${plan.folder}`;
      const ctx: ExecContext = {
        store,
        profile,
        plan,
        lock,
        control,
        clock,
        platform: this.deps.platform,
        pluginVersion: this.deps.pluginVersion,
        index,
        previousState: state ?? emptyState(0, SCHEMA_VERSION.state),
        keys: await this.keysFor(plan),
        yieldIfNeeded: this.deps.yieldIfNeeded ?? createYielder(),
        nonDestructive: options.nonDestructive === true,
        resume: resume ?? undefined,
      };
      const result = await executePlan(ctx);
      logger.info(`Backup ${plan.id} completed (${result.bytes} bytes)`);
      return result;
    } catch (error) {
      await cleanUpFailedRun(store, backupFolder, createdFolder);
      if (error instanceof CancelledError) logger.info("Backup cancelled");
      else logger.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await lock.release();
    }
  }

  /** Refuse to start when the estimated output (plus the configured reserve) will not fit. */
  private async checkSpace(
    plan: RunPlan,
    profile: SettingsProfile,
    fromPart: number,
  ): Promise<void> {
    if (!this.deps.freeSpace) return;
    const remaining = plan.parts.slice(fromPart).flat();
    const required = estimateBackupBytes(remaining, profile.zip.compressionLevel);
    const result = await assertFreeSpace(
      this.deps.freeSpace,
      required,
      profile.conditions.minFreeSpaceMb,
    );
    if (!result.known) this.deps.logger.debug("Free space unknown on this platform, check skipped");
  }

  private announce(plan: RunPlan, resumed: boolean): void {
    const verb = resumed ? "Resuming backup" : "Backup";
    this.deps.logger.info(`${verb} ${plan.id}: ${plan.type}, ${plan.parts.flat().length} files`);
    if (plan.forcedFullReason) {
      this.deps.logger.warn(`Differential backup became a full backup: ${plan.forcedFullReason}`);
    }
  }

  private async existingBackupFolders(backupFolder: string, except?: string): Promise<Set<string>> {
    const { store } = this.deps;
    if (!(await store.exists(backupFolder))) return new Set();
    const { folders } = await store.list(backupFolder);
    const names = folders.map((f) => f.slice(backupFolder.length + 1));
    return new Set(names.filter((n) => n !== except));
  }

  /** A damaged state.json must not block backups: the planner turns null into a full backup. */
  private async loadStateOrNull(backupFolder: string): Promise<BackupState | null> {
    try {
      return await loadState(this.deps.store, backupFolder);
    } catch (error) {
      this.deps.logger.warn(
        `Backup state unreadable, a full backup will be made: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async keysFor(plan: RunPlan): Promise<ExecContext["keys"]> {
    if (!plan.encryption.enabled) return null;
    const master = await this.deps.deriveMasterKey(
      fromBase64(plan.encryption.salt),
      plan.encryption.iterations,
    );
    return {
      encryptionKey: await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt)),
      hmacKey: await deriveSubKey(master, KEY_LABELS.manifestHmac),
    };
  }
}
