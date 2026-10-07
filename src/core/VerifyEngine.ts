import { CancelledError, ManifestError, VerificationError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { Manifest, SettingsProfile, VerifyIssue, VerifyLevel, VerifyReport } from "../types";
import { findBackup, loadIndex } from "./BackupIndex";
import { loadManifest } from "./Manifest";
import type { MasterKeyFn } from "./RestoreReader";
import { checkPartContent } from "./VerifyContent";
import { pickSample, seededRandom } from "../helpers/random";
import { checkChain } from "./VerifyChain";
import { prepareKeys } from "./VerifyKeys";
import { checkEntryParts, checkPartStructure } from "./VerifyStructure";

export interface VerifyDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
  /** Lets level 3 read inside encrypted backups. Wired to PassphraseService.getKey. */
  deriveMasterKey?: MasterKeyFn;
  yieldIfNeeded?: () => Promise<void>;
}

export interface VerifyProgress {
  level: VerifyLevel;
  partIndex: number;
  partCount: number;
}

export interface VerifyOptions {
  level: VerifyLevel;
  /**
   * Check the contents of only about `pct` percent of the entries, chosen at random (the same
   * `seed` always picks the same ones). Structure and chain checks stay complete. Ignored below
   * level 2, and 100 means everything.
   */
  sample?: { pct: number; seed?: number };
  onProgress?: (progress: VerifyProgress) => void;
  /** Polled between parts and entries; when true the check stops with CancelledError. */
  isCancelled?: () => boolean;
}

/** Highest level this engine can run so far (1 structure, 2 CRC, 3 SHA-256, 4 decrypt + signature, 5 chain). */
const MAX_LEVEL: VerifyLevel = 5;

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

    const index = await loadIndex(store, backupFolder);
    const backup = findBackup(index, backupId);
    if (!backup) throw new VerificationError(`Backup "${backupId}" is not in the backup index`);

    const sampling = options.sample;
    if (sampling && !(sampling.pct > 0 && sampling.pct <= 100)) {
      throw new VerificationError("Sampling percentage must be above 0 and at most 100");
    }
    const issues: VerifyIssue[] = [];
    const skipped: string[] = [];
    let sampleInfo: VerifyReport["sample"];
    let entriesChecked = 0;
    const folder = `${backupFolder}/${backup.folder}`;
    const manifest = await this.readManifest(folder, issues);
    if (manifest && (manifest.id !== backup.id || manifest.type !== backup.type)) {
      issues.push({ message: "The manifest does not match the backup index" });
    }
    if (manifest) {
      issues.push(...checkEntryParts(manifest));
      const yielder = this.deps.yieldIfNeeded ?? createYielder();
      const tick = async (): Promise<void> => {
        if (isCancelled()) throw new CancelledError("Verification cancelled");
        await yielder();
      };
      const encryptionKey = await prepareKeys(
        this.deps.deriveMasterKey,
        manifest,
        options.level,
        issues,
        skipped,
      );
      let sample: Set<string> | undefined;
      if (sampling && sampling.pct < 100 && options.level >= 2) {
        const paths = manifest.entries.map((e) => e.path);
        sample = pickSample(paths, sampling.pct, seededRandom(sampling.seed ?? clock.now()));
        sampleInfo = { pct: sampling.pct, entriesSampled: sample.size, entriesTotal: paths.length };
      }
      for (const [i, part] of manifest.parts.entries()) {
        await tick();
        options.onProgress?.({
          level: options.level,
          partIndex: i + 1,
          partCount: manifest.parts.length,
        });
        const path = `${folder}/${part.name}`;
        const data = (await store.exists(path)) ? await store.readBinary(path) : null;
        const directory = checkPartStructure(manifest, part, data, issues);
        if (directory) entriesChecked += directory.length;
        if (data && directory && options.level >= 2) {
          await checkPartContent(
            {
              part,
              data,
              directory,
              expected: new Map(
                manifest.entries.filter((e) => e.part === part.name).map((e) => [e.path, e]),
              ),
              // Without a key the contents of encrypted entries cannot be hashed: stop at L2.
              level: options.level >= 3 && (!manifest.encryption.enabled || encryptionKey) ? 3 : 2,
              encryptionKey,
              sample,
              tick,
            },
            issues,
          );
        }
      }
    }
    if (options.level >= 5) {
      const chain = await checkChain(store, backupFolder, index, backup);
      issues.push(...chain.issues);
      // Every backup this one depends on must itself be intact; a quick integrity pass each.
      for (const dep of chain.dependencies) {
        const sub = await this.verify(dep.id, {
          level: 2,
          sample: options.sample,
          isCancelled: options.isCancelled,
        });
        for (const issue of sub.issues)
          issues.push({ ...issue, backupId: issue.backupId ?? dep.id });
        entriesChecked += sub.entriesChecked;
      }
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
      ...(sampleInfo ? { sample: sampleInfo } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
    };
    this.deps.logger.info(
      `Verify L${report.level} of ${backupId}: ${report.result}, ${issues.length} issue(s)` +
        (skipped.length > 0 ? `, ${skipped.length} check(s) skipped` : ""),
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
