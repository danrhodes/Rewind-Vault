import { SCHEMA_VERSION } from "../constants";
import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { fromBase64 } from "../helpers/bytes";
import { CancelledError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupState, PlatformKind, SettingsProfile } from "../types";
import { loadIndex } from "./BackupIndex";
import { executePlan, type ExecContext } from "./BackupExecutor";
import { planBackup, type RunPlan } from "./BackupPlanner";
import { loadState } from "./BackupState";
import { emptyState } from "./Differ";
import { LockManager, type LockOptions } from "./LockManager";
import { guardStore } from "./NonDestructiveGuard";
import { RunControl } from "./RunControl";
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
  /** Test seams. */
  yieldIfNeeded?: () => Promise<void>;
  lockOptions?: Partial<LockOptions>;
}

export class BackupEngine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Run one backup. Resolves with the result, or throws: CancelledError when cancelled,
   * LockError when another run is active, anything else on failure. Whatever the outcome,
   * a half-made backup folder is removed, the lock is released, and previous backups,
   * the index and the state are left as they were.
   */
  async run(options: RunOptions): Promise<RunResult> {
    const { logger, clock } = this.deps;
    const profile = this.deps.getProfile();
    const backupFolder = profile.destination.backupFolder;
    const store = options.nonDestructive
      ? guardStore(this.deps.store, backupFolder, await this.existingBackupFolders(backupFolder))
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
      const state = await this.loadStateOrNull(backupFolder);
      const { plan } = await planBackup({
        store,
        profile,
        requested: options.mode,
        now: clock.now(),
        index,
        state,
        yieldIfNeeded: this.deps.yieldIfNeeded,
      });
      control.assertNotCancelled();
      this.announce(plan);
      control.update({
        partCount: plan.parts.length,
        filesTotal: plan.parts.flat().length,
        bytesTotal: plan.totalBytes,
      });

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
      };
      const result = await executePlan(ctx);
      logger.info(`Backup ${plan.id} completed (${result.bytes} bytes)`);
      return result;
    } catch (error) {
      if (createdFolder && (await store.exists(createdFolder))) {
        await store.removeFolder(createdFolder).catch(() => undefined);
      }
      if (error instanceof CancelledError) logger.info("Backup cancelled");
      else logger.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await lock.release();
    }
  }

  private announce(plan: RunPlan): void {
    this.deps.logger.info(`Backup ${plan.id}: ${plan.type}, ${plan.parts.flat().length} files`);
    if (plan.forcedFullReason) {
      this.deps.logger.warn(`Differential backup became a full backup: ${plan.forcedFullReason}`);
    }
  }

  private async existingBackupFolders(backupFolder: string): Promise<Set<string>> {
    const { store } = this.deps;
    if (!(await store.exists(backupFolder))) return new Set();
    const { folders } = await store.list(backupFolder);
    return new Set(folders.map((f) => f.slice(backupFolder.length + 1)));
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
