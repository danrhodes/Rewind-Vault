import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { signManifest } from "../crypto/sign";
import { fromBase64 } from "../helpers/bytes";
import { ENCRYPTION, SCHEMA_VERSION } from "../constants";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { createYielder } from "../helpers/yieldToUI";
import { writeAtomic } from "../storage/AtomicWriter";
import type { IVaultStore } from "../storage/VaultStore";
import type {
  BackupIndex,
  BackupState,
  BackupType,
  Manifest,
  ManifestEntry,
  ManifestPart,
  PlatformKind,
  SettingsProfile,
} from "../types";
import { addBackup, entryFromManifest, loadIndex, saveIndex } from "./BackupIndex";
import { planBackup, type RunPlan } from "./BackupPlanner";
import { loadState, saveState } from "./BackupState";
import { applyDiffToState, emptyState, stateFromHashed, type HashedFile } from "./Differ";
import { LockManager, type LockOptions } from "./LockManager";
import { createManifest, saveManifest } from "./Manifest";
import { guardStore } from "./NonDestructiveGuard";
import { packPart } from "./Packer";
import { partName } from "./Splitter";

export interface EngineDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
  platform: PlatformKind;
  pluginVersion: string;
  /** PBKDF2 master key for a salt. Wired to PassphraseService.getKey in services. */
  deriveMasterKey: (salt: Uint8Array, iterations: number) => Promise<Uint8Array>;
  /** Test seams. */
  yieldIfNeeded?: () => Promise<void>;
  lockOptions?: Partial<LockOptions>;
}

export interface RunOptions {
  mode: BackupType;
  /**
   * Only add backups: existing backup folders are write-protected for this run and
   * retention must not run afterwards.
   */
  nonDestructive?: boolean;
}

export interface RunResult {
  status: "completed";
  backupId: string;
  type: BackupType;
  fileCount: number;
  bytes: number;
  skippedFiles: string[];
  /** Set when a differential was requested but a full backup was made instead. */
  forcedFullReason?: string;
  nonDestructive: boolean;
}

export class BackupEngine {
  constructor(private readonly deps: EngineDeps) {}

  async run(options: RunOptions): Promise<RunResult> {
    const { logger, clock } = this.deps;
    const profile = this.deps.getProfile();
    const backupFolder = profile.destination.backupFolder;
    const store = options.nonDestructive
      ? guardStore(this.deps.store, backupFolder, await this.existingBackupFolders(backupFolder))
      : this.deps.store;

    const lock = new LockManager(store, backupFolder, clock, {
      timeoutMin: profile.safety.lockTimeoutMin,
      platform: this.deps.platform,
      ...this.deps.lockOptions,
    });
    await lock.acquire();

    let createdFolder: string | null = null;
    try {
      const index = await loadIndex(store, backupFolder);
      const state = await this.loadStateOrNull(backupFolder);
      const { plan } = await planBackup({
        store,
        profile,
        requested: options.mode,
        now: clock.now(),
        index,
        state,
        yieldIfNeeded: this.deps.yieldIfNeeded,
      });
      logger.info(`Backup ${plan.id}: ${plan.type}, ${plan.parts.flat().length} files`);
      if (plan.forcedFullReason) {
        logger.warn(`Differential backup became a full backup: ${plan.forcedFullReason}`);
      }

      createdFolder = `${backupFolder}/${plan.folder}`;
      const result = await this.execute(
        plan,
        profile,
        lock,
        index,
        options,
        state ?? emptyState(0, SCHEMA_VERSION.state),
        store,
      );
      logger.info(`Backup ${plan.id} completed (${result.bytes} bytes)`);
      return result;
    } catch (error) {
      if (createdFolder && (await store.exists(createdFolder))) {
        await store.removeFolder(createdFolder).catch(() => undefined);
      }
      logger.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await lock.release();
    }
  }

  private async execute(
    plan: RunPlan,
    profile: SettingsProfile,
    lock: LockManager,
    index: BackupIndex,
    options: RunOptions,
    previousState: BackupState,
    store: IVaultStore,
  ): Promise<RunResult> {
    const backupFolder = profile.destination.backupFolder;
    const folderPath = `${backupFolder}/${plan.folder}`;
    const yieldIfNeeded = this.deps.yieldIfNeeded ?? createYielder();

    const keys = await this.keysFor(plan);
    await store.mkdir(folderPath);

    const parts: ManifestPart[] = [];
    const entries: ManifestEntry[] = [];
    const packed: HashedFile[] = [];
    const skippedFiles: string[] = [];
    let bytes = 0;

    for (const planned of plan.parts) {
      await lock.refresh();
      const actions = new Map(planned.map((f) => [f.path, f.action]));
      const part = await packPart(
        store,
        planned,
        {
          compressionLevel: profile.zip.compressionLevel,
          encryptionKey: keys?.encryptionKey,
          chunkSize: profile.misc.chunkSizeKb * 1024,
        },
        yieldIfNeeded,
      );
      skippedFiles.push(...part.skipped);
      if (part.entries.length === 0) continue;

      const name = partName(parts.length + 1);
      await writeAtomic(store, `${folderPath}/${name}`, part.data);
      parts.push({
        name,
        size: part.data.length,
        sha256: part.sha256,
        entryCount: part.entries.length,
      });
      bytes += part.data.length;
      for (const e of part.entries) {
        entries.push({ ...e, part: name, action: actions.get(e.path) ?? "add" });
        packed.push(e);
      }
    }

    const manifest: Manifest = {
      ...createManifest({
        id: plan.id,
        type: plan.type,
        baseId: plan.baseId,
        createdAt: plan.createdAt,
        pluginVersion: this.deps.pluginVersion,
        platform: this.deps.platform,
        encryption: {
          enabled: plan.encryption.enabled,
          kdf: ENCRYPTION.kdf,
          iterations: plan.encryption.iterations,
          salt: plan.encryption.salt,
          algo: ENCRYPTION.algo,
        },
      }),
      parts,
      entries,
      tombstones: plan.tombstones,
      status: "ok",
    };
    if (keys) manifest.hmac = await signManifest(manifest, keys.hmacKey);

    // Manifest last: a backup folder without one is an unfinished backup.
    await saveManifest(store, folderPath, manifest);
    await saveIndex(
      store,
      backupFolder,
      addBackup(index, entryFromManifest(manifest, plan.folder, bytes)),
    );

    const now = this.deps.clock.now();
    const next =
      plan.type === "full"
        ? stateFromHashed(packed, now, previousState.schemaVersion)
        : applyDiffToState(
            previousState,
            { added: [], changed: [], touched: plan.touched, deleted: plan.deleted, unchanged: 0 },
            packed,
            now,
          );
    await saveState(store, backupFolder, next);

    return {
      status: "completed",
      backupId: plan.id,
      type: plan.type,
      fileCount: entries.length,
      bytes,
      skippedFiles: [...plan.skippedOverMax, ...skippedFiles],
      forcedFullReason: plan.forcedFullReason,
      nonDestructive: options.nonDestructive === true,
    };
  }

  private async existingBackupFolders(backupFolder: string): Promise<Set<string>> {
    const { store } = this.deps;
    if (!(await store.exists(backupFolder))) return new Set();
    const { folders } = await store.list(backupFolder);
    return new Set(folders.map((f) => f.slice(backupFolder.length + 1)));
  }

  /** A damaged state.json must not block backups: the planner turns null into a full backup. */
  private async loadStateOrNull(backupFolder: string): Promise<BackupState | null> {
    try {
      return await loadState(this.deps.store, backupFolder);
    } catch (error) {
      this.deps.logger.warn(
        `Backup state unreadable, a full backup will be made: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async keysFor(
    plan: RunPlan,
  ): Promise<{ encryptionKey: CryptoKey; hmacKey: Uint8Array } | null> {
    if (!plan.encryption.enabled) return null;
    const master = await this.deps.deriveMasterKey(
      fromBase64(plan.encryption.salt),
      plan.encryption.iterations,
    );
    return {
      encryptionKey: await importAesKey(await deriveSubKey(master, KEY_LABELS.encrypt)),
      hmacKey: await deriveSubKey(master, KEY_LABELS.manifestHmac),
    };
  }
}
