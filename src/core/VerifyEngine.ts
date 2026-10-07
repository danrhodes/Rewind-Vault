import { CancelledError, ManifestError, VerificationError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import type { IVaultStore } from "../storage/VaultStore";
import type { Manifest, SettingsProfile, VerifyIssue, VerifyLevel, VerifyReport } from "../types";
import { findBackup, loadIndex } from "./BackupIndex";
import { loadManifest } from "./Manifest";
import { checkStructure } from "./VerifyStructure";

export interface VerifyDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
}

export interface VerifyProgress {
  level: VerifyLevel;
  partIndex: number;
  partCount: number;
}

export interface VerifyOptions {
  level: VerifyLevel;
  onProgress?: (progress: VerifyProgress) => void;
  /** Polled between parts; when true the check stops with CancelledError. */
  isCancelled?: () => boolean;
}

/** Highest level this engine can run so far. */
const MAX_LEVEL: VerifyLevel = 1;

/**
 * Checks that a backup can be trusted. Levels are cumulative: asking for level N runs every
 * check up to N and reports all problems found. Read-only: it never changes a backup, the
 * index or any state; recording the outcome is the caller's job.
 */
export class VerifyEngine {
  constructor(private readonly deps: VerifyDeps) {}

  async verify(backupId: string, options: VerifyOptions): Promise<VerifyReport> {
    if (options.level > MAX_LEVEL) {
      throw new VerificationError(`Verification level ${options.level} is not available yet`);
    }
    const { store, clock } = this.deps;
    const startedAt = clock.now();
    const backupFolder = this.deps.getProfile().destination.backupFolder;
    const isCancelled = options.isCancelled ?? ((): boolean => false);

    const backup = findBackup(await loadIndex(store, backupFolder), backupId);
    if (!backup) throw new VerificationError(`Backup "${backupId}" is not in the backup index`);

    const issues: VerifyIssue[] = [];
    let entriesChecked = 0;
    const manifest = await this.readManifest(`${backupFolder}/${backup.folder}`, issues);
    if (manifest && (manifest.id !== backup.id || manifest.type !== backup.type)) {
      issues.push({ message: "The manifest does not match the backup index" });
    }
    if (manifest) {
      const found = await checkStructure(
        store,
        `${backupFolder}/${backup.folder}`,
        manifest,
        isCancelled,
        (partIndex, partCount) =>
          options.onProgress?.({ level: options.level, partIndex, partCount }),
      );
      issues.push(...found.issues);
      entriesChecked = found.entriesChecked;
    }
    if (isCancelled()) throw new CancelledError("Verification cancelled");

    const report: VerifyReport = {
      backupId,
      level: options.level,
      startedAt,
      finishedAt: clock.now(),
      result: issues.length === 0 ? "pass" : "fail",
      entriesChecked,
      issues,
    };
    this.deps.logger.info(
      `Verify L${report.level} of ${backupId}: ${report.result}, ${issues.length} issue(s)`,
    );
    return report;
  }

  private async readManifest(folder: string, issues: VerifyIssue[]): Promise<Manifest | null> {
    try {
      return await loadManifest(this.deps.store, folder);
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error;
      issues.push({ message: `Manifest cannot be read: ${error.message}` });
      return null;
    }
  }
}
