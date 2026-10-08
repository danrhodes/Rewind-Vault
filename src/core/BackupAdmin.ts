import { SCHEMA_VERSION } from "../constants";
import { BackupAdminError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupEntry, BackupIndex, PlatformKind } from "../types";
import {
  chainFor,
  countsTowardRetention,
  findBackup,
  loadIndex,
  removeBackup,
  saveIndex,
  updateBackup,
} from "./BackupIndex";
import { saveState } from "./BackupState";
import { emptyState } from "./Differ";
import { LockManager, type LockOptions } from "./LockManager";

export interface AdminDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  backupFolder: string;
  lockTimeoutMin: number;
  platform: PlatformKind;
  lockOptions?: Partial<LockOptions>;
}

/** Everything that would be lost, or left unusable, if a backup were deleted. */
export interface DeleteImpact {
  entry: BackupEntry;
  /** Other backups that cannot be restored without this one (newer diffs built on it). */
  dependents: BackupEntry[];
  pinned: boolean;
  /** Deleting the only intact backup leaves nothing restorable. */
  lastIntact: boolean;
}

export interface DeleteOptions {
  /** Also delete the dependents. Required when there are any. */
  cascade?: boolean;
  /** Required to delete a pinned backup (or a pinned dependent). */
  force?: boolean;
}

/** Backups restorable only with `id`: diffs whose restore chain includes it. */
export function dependentsOf(index: BackupIndex, id: string): BackupEntry[] {
  return index.backups.filter(
    (b) => b.id !== id && (chainFor(index, b.id)?.some((link) => link.id === id) ?? false),
  );
}

export function deleteImpact(index: BackupIndex, id: string): DeleteImpact {
  const entry = findBackup(index, id);
  if (!entry) throw new BackupAdminError(`Backup "${id}" is not registered`);
  const dependents = dependentsOf(index, id);
  const doomed = new Set([id, ...dependents.map((d) => d.id)]);
  const remainingIntact = index.backups.some((b) => countsTowardRetention(b) && !doomed.has(b.id));
  return {
    entry,
    dependents,
    pinned: entry.pinned || dependents.some((d) => d.pinned),
    lastIntact: countsTowardRetention(entry) && !remainingIntact,
  };
}

/**
 * Manual management of existing backups: pin, label, delete. Every change runs under the backup
 * lock (the index is shared with running backups) and is refused with a LockError if a backup
 * or verification holds it.
 */
export class BackupAdmin {
  constructor(private readonly deps: AdminDeps) {}

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const { store, clock, backupFolder, lockTimeoutMin, platform, lockOptions } = this.deps;
    const lock = new LockManager(store, backupFolder, clock, {
      timeoutMin: lockTimeoutMin,
      platform,
      ...lockOptions,
    });
    await lock.acquire();
    try {
      return await work();
    } finally {
      await lock.release();
    }
  }

  /**
   * Forget what the last backup saw (state.json), so the next backup starts from a full one
   * and the "nothing changed" check cannot skip it. No backup is touched or deleted.
   */
  resetState(): Promise<void> {
    return this.withLock(async () => {
      const { store, logger, backupFolder } = this.deps;
      await saveState(store, backupFolder, emptyState(0, SCHEMA_VERSION.state));
      logger.info("Backup state reset: the next backup will be a full backup");
    });
  }

  /** Pin (exempt from retention) or unpin. A label names the milestone. */
  setPinned(id: string, pinned: boolean, label?: string): Promise<void> {
    return this.withLock(async () => {
      const { store, backupFolder } = this.deps;
      const index = await loadIndex(store, backupFolder);
      const patch: Partial<Omit<BackupEntry, "id">> = { pinned };
      if (pinned && label !== undefined && label.trim() !== "") patch.label = label.trim();
      if (!pinned) patch.label = undefined;
      const next = updateBackup(index, id, patch);
      await saveIndex(store, backupFolder, withoutUndefinedLabel(next));
    });
  }

  /**
   * Delete a backup. Throws BackupAdminError unless the caller opted in to the consequences: `cascade` when other backups depend on it, `force` when anything pinned would
   * go. The index is saved before folders are removed, so a crash leaves a harmless leftover
   * folder, never an index entry pointing at nothing. Returns the ids removed.
   */
  deleteBackup(id: string, options: DeleteOptions = {}): Promise<string[]> {
    return this.withLock(async () => {
      const { store, logger, backupFolder } = this.deps;
      const index = await loadIndex(store, backupFolder);
      const impact = deleteImpact(index, id);
      if (impact.dependents.length > 0 && !options.cascade) {
        throw new BackupAdminError(
          `${impact.dependents.length} newer backup(s) depend on ${id}. Delete them too, or keep this one.`,
        );
      }
      if (impact.pinned && !options.force) {
        throw new BackupAdminError(
          "A pinned backup is affected. Unpin it first or confirm the deletion.",
        );
      }
      const doomed = [impact.entry, ...impact.dependents];
      let next = index;
      for (const b of doomed) next = removeBackup(next, b.id);
      await saveIndex(store, backupFolder, next);

      const removed: string[] = [];
      for (const b of doomed) {
        try {
          await store.removeFolder(`${backupFolder}/${b.folder}`);
          removed.push(b.id);
          logger.info(`Deleted backup ${b.id}`);
        } catch (error) {
          logger.warn(
            `Backup ${b.id} was unregistered but its folder could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return removed;
    });
  }
}

/** JSON drops undefined keys on save, but validateIndex runs first: remove them explicitly. */
function withoutUndefinedLabel(index: BackupIndex): BackupIndex {
  return {
    ...index,
    backups: index.backups.map((b) => {
      if (b.label !== undefined) return b;
      const { label: _label, ...rest } = b;
      void _label;
      return rest;
    }),
  };
}
