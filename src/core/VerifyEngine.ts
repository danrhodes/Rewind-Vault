import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { fromBase64 } from "../helpers/bytes";
import { CancelledError, ManifestError, RewindError, VerificationError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { Manifest, SettingsProfile, VerifyIssue, VerifyLevel, VerifyReport } from "../types";
import { findBackup, loadIndex } from "./BackupIndex";
import { loadManifest } from "./Manifest";
import type { MasterKeyFn } from "./RestoreReader";
import { checkPartContent } from "./VerifyContent";
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
  onProgress?: (progress: VerifyProgress) => void;
  /** Polled between parts and entries; when true the check stops with CancelledError. */
  isCancelled?: () => boolean;
}

/** Highest level this engine can run so far (1 structure, 2 CRC, 3 SHA-256). */
const MAX_LEVEL: VerifyLevel = 3;

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
    const skipped: string[] = [];
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
      const encryptionKey = options.level >= 3 ? await this.keyFor(manifest, skipped) : undefined;
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
              tick,
            },
            issues,
          );
        }
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
      ...(skipped.length > 0 ? { skipped } : {}),
    };
    this.deps.logger.info(
      `Verify L${report.level} of ${backupId}: ${report.result}, ${issues.length} issue(s)` +
        (skipped.length > 0 ? `, ${skipped.length} check(s) skipped` : ""),
    );
    return report;
  }

  /** Key for reading inside an encrypted backup, or undefined (noting why in `skipped`). */
  private async keyFor(manifest: Manifest, skipped: string[]): Promise<CryptoKey | undefined> {
    const info = manifest.encryption;
    if (!info.enabled) return undefined;
    if (!this.deps.deriveMasterKey) {
      skipped.push("Entry SHA-256 of an encrypted backup needs the passphrase; not checked");
      return undefined;
    }
    try {
      const master = await this.deps.deriveMasterKey(fromBase64(info.salt), info.iterations);
      return await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt));
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      const why = error instanceof RewindError ? error.message : "key derivation failed";
      skipped.push(`Entry SHA-256 of an encrypted backup not checked: ${why}`);
      return undefined;
    }
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
