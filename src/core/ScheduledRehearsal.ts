import { FILE_NAMES } from "../constants";
import { LockError } from "../helpers/errors";
import { writeAtomicText } from "../storage/AtomicWriter";
import { readText } from "../storage/VaultStore";
import type { VerifyReport } from "../types";
import { loadIndex, sortedBackups } from "./BackupIndex";
import { verifyAndRecord, type VerifyRunnerDeps } from "./VerifyRunner";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVEL_REHEARSAL = 6;

/** What the last scheduled rehearsal did, kept in `<backupFolder>/rehearsal.json`. */
export interface RehearsalRecord {
  lastRunAt: number;
  backupId: string;
  result: "pass" | "fail";
}

function recordPath(backupFolder: string): string {
  return `${backupFolder}/${FILE_NAMES.rehearsal}`;
}

export async function loadRehearsalRecord(
  deps: Pick<VerifyRunnerDeps, "store">,
  backupFolder: string,
): Promise<RehearsalRecord | null> {
  try {
    const raw = JSON.parse(
      await readText(deps.store, recordPath(backupFolder)),
    ) as Partial<RehearsalRecord>;
    if (typeof raw.lastRunAt === "number" && typeof raw.backupId === "string") {
      return {
        lastRunAt: raw.lastRunAt,
        backupId: raw.backupId,
        result: raw.result === "fail" ? "fail" : "pass",
      };
    }
  } catch {
    // Missing or unreadable: treated as never run.
  }
  return null;
}

/**
 * True when scheduled rehearsal is on, there is an intact backup to rehearse, the last
 * rehearsal is at least `rehearsalIntervalDays` old (or never happened), and the passphrase
 * question is settled: an encrypted backup is only rehearsed when `canDecrypt()` says a
 * passphrase is available without asking, so a background run never pops up a dialog.
 */
export async function isRehearsalDue(
  deps: VerifyRunnerDeps,
  canDecrypt: () => boolean,
): Promise<boolean> {
  const profile = deps.getProfile();
  if (!profile.verification.scheduledRehearsal) return false;
  if (profile.encryption.enabled && !canDecrypt()) return false;
  const folder = profile.destination.backupFolder;
  const index = await loadIndex(deps.store, folder);
  if (!index.backups.some((b) => b.status === "ok")) return false;
  const last = await loadRehearsalRecord(deps, folder);
  const days = Math.max(1, profile.verification.rehearsalIntervalDays);
  return last === null || deps.clock.now() - last.lastRunAt >= days * DAY_MS;
}

/**
 * Restore rehearsal (level 6) of the newest intact backup: restores it into memory, checks
 * every file against its recorded hash and compares with the vault. A failure marks the
 * backup corrupt like any verification. Returns the report, or null when it could not run
 * (nothing to rehearse, or a backup or verification holds the lock: tried again later).
 */
export async function runScheduledRehearsal(deps: VerifyRunnerDeps): Promise<VerifyReport | null> {
  const folder = deps.getProfile().destination.backupFolder;
  const newest = sortedBackups(await loadIndex(deps.store, folder)).find((b) => b.status === "ok");
  if (!newest) return null;

  let report: VerifyReport;
  try {
    report = await verifyAndRecord(deps, newest.id, { level: LEVEL_REHEARSAL });
  } catch (error) {
    if (error instanceof LockError) {
      deps.logger.debug("Restore rehearsal postponed: a backup or verification is running");
      return null;
    }
    throw error;
  }
  // A pass without rehearsal results means the rehearsal itself did not run (for example no
  // passphrase): that proved nothing, so it is not recorded and will be tried again.
  if (report.result === "pass" && !report.rehearsal) {
    deps.logger.info(`Restore rehearsal did not run: ${report.skipped?.join("; ") ?? "no result"}`);
    return report;
  }
  const record: RehearsalRecord = {
    lastRunAt: deps.clock.now(),
    backupId: newest.id,
    result: report.result,
  };
  await writeAtomicText(deps.store, recordPath(folder), JSON.stringify(record, null, 2));
  deps.logger.info(`Restore rehearsal of ${newest.id}: ${report.result}`);
  return report;
}
