import type { ILogger } from "../helpers/logger";
import type { IVaultStore } from "../storage/VaultStore";
import type { RetentionSettings } from "../types";
import { countsTowardRetention, loadIndex, removeBackup, saveIndex } from "./BackupIndex";
import { planRetention } from "./Retention";

export interface RetentionResult {
  /** Ids removed from the index and (unless listed in `failed`) from disk. */
  pruned: string[];
  /** Ids unregistered but whose folder could not be deleted; harmless leftovers. */
  failed: string[];
}

export interface RetentionDeps {
  store: IVaultStore;
  logger: ILogger;
  backupFolder: string;
  settings: RetentionSettings;
  now: number;
}

/**
 * Prune old backups according to the policy. The caller must hold the backup lock (the index
 * is rewritten). Order matters for crash safety: the index is saved FIRST, then folders are
 * deleted. A crash in between leaves an unregistered folder (wasted space, nothing broken);
 * the other order could leave an index entry pointing at a missing folder, which would break
 * the restore chain of everything built on it.
 */
export async function applyRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const { store, logger, backupFolder } = deps;
  const index = await loadIndex(store, backupFolder);
  const plan = planRetention(index, deps.settings, deps.now);
  if (plan.prune.length === 0) return { pruned: [], failed: [] };

  // Belt and braces: whatever the planner decided, never leave a vault with history but no
  // intact backup.
  const hadIntact = index.backups.some(countsTowardRetention);
  const pruneIds = new Set(plan.prune.map((b) => b.id));
  const remainingIntact = index.backups.some(
    (b) => countsTowardRetention(b) && !pruneIds.has(b.id),
  );
  if (hadIntact && !remainingIntact) {
    logger.error("Retention refused to remove the last intact backup");
    return { pruned: [], failed: [] };
  }

  let next = index;
  for (const b of plan.prune) next = removeBackup(next, b.id);
  await saveIndex(store, backupFolder, next);

  const result: RetentionResult = { pruned: [], failed: [] };
  for (const b of plan.prune) {
    try {
      await store.removeFolder(`${backupFolder}/${b.folder}`);
      result.pruned.push(b.id);
      logger.info(`Retention removed backup ${b.id}`);
    } catch (error) {
      result.failed.push(b.id);
      logger.warn(
        `Retention could not delete the folder of ${b.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
