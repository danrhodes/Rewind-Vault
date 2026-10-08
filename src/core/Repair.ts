import { sha256Hex } from "../crypto/hash";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { writeAtomic } from "../storage/AtomicWriter";
import type { IVaultStore } from "../storage/VaultStore";
import { findBackup, loadIndex, saveIndex, updateBackup } from "./BackupIndex";
import { loadManifest, saveManifest } from "./Manifest";
import { RECOVERY_SUFFIX, repairWithRecord } from "./RecoveryRecord";

export interface RepairReport {
  backupId: string;
  /** Parts whose bytes did not match the manifest and were rebuilt. */
  repaired: string[];
  /** Parts that were already correct. */
  intact: string[];
  /** Parts that could not be repaired, with the reason. */
  failed: { part: string; reason: string }[];
  /** The backup was marked damaged and every part is now byte-exact, so it is intact again. */
  healed: boolean;
}

export interface RepairDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  backupFolder: string;
  yieldIfNeeded?: () => Promise<void>;
}

/**
 * Rebuild damaged parts of a backup from their recovery records (`part-001.zip.rr`). A part is
 * only replaced when the rebuilt bytes hash to exactly the SHA-256 the manifest recorded when
 * the backup was made, so a repair can never produce a wrong file. The caller holds the backup
 * lock. When every part is correct afterwards and the backup was marked damaged, it is marked
 * intact again (byte-identical parts are the strongest proof there is).
 */
export async function repairBackup(deps: RepairDeps, backupId: string): Promise<RepairReport> {
  const { store, logger, backupFolder } = deps;
  const index = await loadIndex(store, backupFolder);
  const entry = findBackup(index, backupId);
  if (!entry) throw new Error(`Backup "${backupId}" is not in the backup index`);
  const folder = `${backupFolder}/${entry.folder}`;
  const manifest = await loadManifest(store, folder);

  const report: RepairReport = { backupId, repaired: [], intact: [], failed: [], healed: false };
  for (const part of manifest.parts) {
    const path = `${folder}/${part.name}`;
    const data = (await store.exists(path)) ? await store.readBinary(path) : null;
    if (data && sha256Hex(data) === part.sha256) {
      report.intact.push(part.name);
      continue;
    }
    const recordPath = `${path}${RECOVERY_SUFFIX}`;
    if (!(await store.exists(recordPath))) {
      report.failed.push({ part: part.name, reason: "There is no recovery record for this part" });
      continue;
    }
    const outcome = repairWithRecord(data, await store.readBinary(recordPath));
    if (outcome.status === "unrecoverable") {
      report.failed.push({ part: part.name, reason: outcome.reason });
      continue;
    }
    const rebuilt = outcome.status === "repaired" ? outcome.data : (data as Uint8Array);
    if (sha256Hex(rebuilt) !== part.sha256) {
      report.failed.push({
        part: part.name,
        reason: "The rebuilt part does not match the checksum in the manifest",
      });
      continue;
    }
    await writeAtomic(store, path, rebuilt);
    report.repaired.push(part.name);
    logger.info(`Repaired ${part.name} of ${backupId} from its recovery record`);
    await deps.yieldIfNeeded?.();
  }

  if (report.failed.length === 0 && report.repaired.length > 0 && entry.status === "corrupt") {
    await saveIndex(store, backupFolder, updateBackup(index, backupId, { status: "ok" }));
    manifest.status = "ok";
    manifest.verify = { lastLevel: 3, lastAt: deps.clock.now(), result: "pass" };
    await saveManifest(store, folder, manifest);
    report.healed = true;
    logger.info(`Backup ${backupId} is intact again after repair`);
  }
  return report;
}
