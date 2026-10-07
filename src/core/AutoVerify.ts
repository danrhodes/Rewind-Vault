import { CancelledError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import type { IVaultStore } from "../storage/VaultStore";
import type { AutoVerifyLevel, SettingsProfile, VerifyLevel, VerifyReport } from "../types";
import { loadManifest, saveManifest } from "./Manifest";
import type { MasterKeyFn } from "./RestoreReader";
import { VerifyEngine } from "./VerifyEngine";

const LEVELS: Record<AutoVerifyLevel, VerifyLevel | null> = {
  off: null,
  L1: 1,
  L2: 2,
  L3: 3,
};

/** The verification level a setting asks for, or null when verification is off. */
export function autoVerifyLevel(setting: AutoVerifyLevel): VerifyLevel | null {
  return LEVELS[setting] ?? null;
}

export interface AutoVerifyDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  profile: SettingsProfile;
  deriveMasterKey?: MasterKeyFn;
  yieldIfNeeded?: () => Promise<void>;
  /** Called before each part is checked; the backup run uses it to keep its lock alive. */
  onPart?: () => Promise<void>;
  isCancelled?: () => boolean;
}

/**
 * Verify a backup that has just been written, at the level the settings choose, and note the
 * outcome in its manifest (`verify`, which the manifest signature deliberately excludes).
 * Returns null when verification is off, was cancelled, or could not run: the backup itself is
 * already complete and valid, so a problem here is logged and never fails the run.
 */
export async function autoVerifyBackup(
  deps: AutoVerifyDeps,
  backupId: string,
  folderPath: string,
): Promise<VerifyReport | null> {
  const level = autoVerifyLevel(deps.profile.verification.autoVerify);
  if (level === null) return null;

  const engine = new VerifyEngine({
    store: deps.store,
    logger: deps.logger,
    clock: deps.clock,
    getProfile: () => deps.profile,
    deriveMasterKey: deps.deriveMasterKey,
    yieldIfNeeded: deps.yieldIfNeeded,
  });
  let report: VerifyReport;
  try {
    report = await engine.verify(backupId, {
      level,
      isCancelled: deps.isCancelled,
      onProgress: () => void deps.onPart?.().catch(() => undefined),
    });
  } catch (error) {
    if (error instanceof CancelledError) {
      deps.logger.info("Verification of the new backup was cancelled");
    } else {
      deps.logger.warn(
        `Could not verify backup ${backupId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }

  try {
    const manifest = await loadManifest(deps.store, folderPath);
    manifest.verify = { lastLevel: level, lastAt: report.finishedAt, result: report.result };
    await saveManifest(deps.store, folderPath, manifest);
  } catch (error) {
    deps.logger.warn(
      `Verified backup ${backupId} but could not record the result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (report.result === "fail") {
    deps.logger.error(`Backup ${backupId} FAILED verification: ${report.issues.length} issue(s)`);
  }
  return report;
}
