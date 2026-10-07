import { FILE_NAMES } from "../constants";
import { LockError } from "../helpers/errors";
import { writeAtomicText } from "../storage/AtomicWriter";
import { readText } from "../storage/VaultStore";
import type { VerifyReport } from "../types";
import { loadIndex, sortedBackups } from "./BackupIndex";
import { verifyAndRecord, type VerifyRunnerDeps } from "./VerifyRunner";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVEL_DEEP = 5;

/** What the last scheduled deep verify did, kept in `<backupFolder>/deep-verify.json`. */
export interface DeepVerifyRecord {
  lastRunAt: number;
  backupId: string;
  result: "pass" | "fail";
}

function recordPath(backupFolder: string): string {
  return `${backupFolder}/${FILE_NAMES.deepVerify}`;
}

export async function loadDeepVerifyRecord(
  deps: Pick<VerifyRunnerDeps, "store">,
  backupFolder: string,
): Promise<DeepVerifyRecord | null> {
  try {
    const raw = JSON.parse(
      await readText(deps.store, recordPath(backupFolder)),
    ) as Partial<DeepVerifyRecord>;
    if (typeof raw.lastRunAt === "number" && typeof raw.backupId === "string") {
      return {
        lastRunAt: raw.lastRunAt,
        backupId: raw.backupId,
        result: raw.result === "fail" ? "fail" : "pass",
      };
    }
  } catch {
    // Missing or unreadable: treated as never run, so the next check runs one.
  }
  return null;
}

/**
 * True when scheduled deep verify is enabled, there is an intact backup to check, and the
 * last deep verify is at least `deepVerifyIntervalDays` old (or never happened).
 */
export async function isDeepVerifyDue(deps: VerifyRunnerDeps): Promise<boolean> {
  const verification = deps.getProfile().verification;
  if (!verification.scheduledDeepVerify) return false;
  const folder = deps.getProfile().destination.backupFolder;
  const index = await loadIndex(deps.store, folder);
  if (!index.backups.some((b) => b.status === "ok")) return false;
  const last = await loadDeepVerifyRecord(deps, folder);
  const days = Math.max(1, verification.deepVerifyIntervalDays);
  return last === null || deps.clock.now() - last.lastRunAt >= days * DAY_MS;
}

/**
 * Deep verify: level 5 on the newest intact backup, which covers its whole chain (every
 * backup it depends on is re-read and integrity-checked). A failure marks the affected backup
 * corrupt like any verification (see BackupFailure). Returns the report, or null when it could
 * not run because a backup or another verify holds the lock (it is simply tried again at the
 * next check) or there is nothing to verify.
 */
export async function runDeepVerify(deps: VerifyRunnerDeps): Promise<VerifyReport | null> {
  const folder = deps.getProfile().destination.backupFolder;
  const newest = sortedBackups(await loadIndex(deps.store, folder)).find((b) => b.status === "ok");
  if (!newest) return null;

  let report: VerifyReport;
  try {
    report = await verifyAndRecord(deps, newest.id, { level: LEVEL_DEEP });
  } catch (error) {
    if (error instanceof LockError) {
      deps.logger.debug("Deep verify postponed: a backup or verification is running");
      return null;
    }
    throw error;
  }
  const record: DeepVerifyRecord = {
    lastRunAt: deps.clock.now(),
    backupId: newest.id,
    result: report.result,
  };
  await writeAtomicText(deps.store, recordPath(folder), JSON.stringify(record, null, 2));
  deps.logger.info(`Deep verify of ${newest.id}: ${report.result}`);
  return report;
}
