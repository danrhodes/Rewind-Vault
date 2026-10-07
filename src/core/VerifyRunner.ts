import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import type { IVaultStore } from "../storage/VaultStore";
import type { PlatformKind, SettingsProfile, VerifyReport } from "../types";
import { recordVerification } from "./BackupFailure";
import { LockManager, type LockOptions } from "./LockManager";
import type { MasterKeyFn } from "./RestoreReader";
import { VerifyEngine, type VerifyOptions } from "./VerifyEngine";

export interface VerifyRunnerDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
  platform: PlatformKind;
  deriveMasterKey?: MasterKeyFn;
  yieldIfNeeded?: () => Promise<void>;
  lockOptions?: Partial<LockOptions>;
}

/**
 * Verify a backup that already exists and record the outcome (manifest `verify`; a failure
 * marks the backup corrupt). Recording rewrites index.json, which a running backup also
 * writes, so the whole thing runs under the backup lock: if a backup (or another verify) holds
 * it, this throws LockError and nothing is changed. Used by scheduled deep verify and by the
 * manual verify command.
 */
export async function verifyAndRecord(
  deps: VerifyRunnerDeps,
  backupId: string,
  options: VerifyOptions,
): Promise<VerifyReport> {
  const profile = deps.getProfile();
  const backupFolder = profile.destination.backupFolder;
  const lock = new LockManager(deps.store, backupFolder, deps.clock, {
    timeoutMin: profile.safety.lockTimeoutMin,
    platform: deps.platform,
    ...deps.lockOptions,
  });
  await lock.acquire();
  try {
    const engine = new VerifyEngine({
      store: deps.store,
      logger: deps.logger,
      clock: deps.clock,
      getProfile: deps.getProfile,
      deriveMasterKey: deps.deriveMasterKey,
      yieldIfNeeded: deps.yieldIfNeeded,
    });
    const report = await engine.verify(backupId, {
      ...options,
      onProgress: (p) => {
        options.onProgress?.(p);
        void lock.refresh().catch(() => undefined);
      },
    });
    await recordVerification(deps.store, backupFolder, report, deps.logger);
    return report;
  } finally {
    await lock.release();
  }
}
