import type { ILogger } from "../helpers/logger";
import type { IVaultStore } from "../storage/VaultStore";
import type { VerifyReport } from "../types";
import { findBackup, loadIndex, saveIndex, updateBackup } from "./BackupIndex";
import { loadManifest, saveManifest } from "./Manifest";

/**
 * Record a verification outcome on a backup. Always writes `verify` into its manifest. When
 * the report is a failure the backup is also marked `corrupt`, in the index first (the
 * registry every consumer trusts) and then in its manifest, so:
 *  - restore and chain resolution refuse it (they accept only status ok),
 *  - retention does not count it (see `countsTowardRetention`),
 *  - the next differential is forced to a full backup (planner, when onFailureForceFull is on).
 * A passing report never heals a backup already marked corrupt: that stays a human decision.
 * Returns whether the backup was newly marked corrupt.
 */
export async function recordVerification(
  store: IVaultStore,
  backupFolder: string,
  report: VerifyReport,
  logger: ILogger,
): Promise<boolean> {
  const index = await loadIndex(store, backupFolder);
  const entry = findBackup(index, report.backupId);
  if (!entry) return false;
  const folder = `${backupFolder}/${entry.folder}`;

  const failed = report.result === "fail";
  const newlyCorrupt = failed && entry.status !== "corrupt";
  if (newlyCorrupt) {
    await saveIndex(store, backupFolder, updateBackup(index, entry.id, { status: "corrupt" }));
    logger.error(`Backup ${entry.id} marked corrupt (${report.issues.length} issue(s))`);
  }

  const manifest = await loadManifest(store, folder);
  manifest.verify = { lastLevel: report.level, lastAt: report.finishedAt, result: report.result };
  if (failed) manifest.status = "corrupt";
  await saveManifest(store, folder, manifest);
  return newlyCorrupt;
}
