import type { ILogger } from "../helpers/logger";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupIndex } from "../types";
import { findBackup } from "./BackupIndex";
import {
  clearCheckpoint,
  completedPartsIntact,
  loadCheckpoint,
  type CheckpointData,
} from "./Checkpoint";

/** Remove a failed or cancelled run's half-made folder and its checkpoint. Never throws. */
export async function cleanUpFailedRun(
  store: IVaultStore,
  backupFolder: string,
  folderPath: string | null,
): Promise<void> {
  try {
    if (folderPath && (await store.exists(folderPath))) await store.removeFolder(folderPath);
    await clearCheckpoint(store, backupFolder);
  } catch {
    // Leftovers are handled by the next run.
  }
}

/** Drop a checkpoint and the unfinished folder it points to (never a finished backup). */
export async function discardUnfinished(
  store: IVaultStore,
  logger: ILogger,
  backupFolder: string,
  index: BackupIndex,
): Promise<void> {
  const cp = await loadCheckpoint(store, backupFolder);
  if (cp && !findBackup(index, cp.plan.id)) {
    const folderPath = `${backupFolder}/${cp.plan.folder}`;
    const unfinished =
      (await store.exists(folderPath)) && !(await store.exists(`${folderPath}/manifest.json`));
    if (unfinished) {
      logger.warn(`Discarding unfinished backup ${cp.plan.id}`);
      await store.removeFolder(folderPath).catch(() => undefined);
    }
  }
  await clearCheckpoint(store, backupFolder);
}

/** The checkpoint if it can still be continued; otherwise it is discarded and null returned. */
export async function usableCheckpoint(
  store: IVaultStore,
  logger: ILogger,
  backupFolder: string,
  index: BackupIndex,
): Promise<CheckpointData | null> {
  const cp = await loadCheckpoint(store, backupFolder);
  if (!cp) {
    await clearCheckpoint(store, backupFolder);
    return null;
  }
  const folderPath = `${backupFolder}/${cp.plan.folder}`;
  const intact =
    !findBackup(index, cp.plan.id) &&
    (await store.exists(folderPath)) &&
    (await completedPartsIntact(store, folderPath, cp));
  if (intact) return cp;
  logger.warn(`Cannot resume backup ${cp.plan.id}: starting a new one instead`);
  await discardUnfinished(store, logger, backupFolder, index);
  return null;
}
