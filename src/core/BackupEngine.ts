import { importAesKey } from "../crypto/cipher";
import { KEY_LABELS, deriveSubKey } from "../crypto/kdf";
import { signManifest } from "../crypto/sign";
import { fromBase64 } from "../helpers/bytes";
import { ENCRYPTION } from "../constants";
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
import { applyDiffToState, stateFromHashed, type HashedFile } from "./Differ";
import { LockManager, type LockOptions } from "./LockManager";
import { createManifest, saveManifest } from "./Manifest";
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
}

export interface RunResult {
  status: "completed";
  backupId: string;
  type: BackupType;
  fileCount: number;
  bytes: number;
  skippedFiles: string[];
}

export class BackupEngine {
  constructor(private readonly deps: EngineDeps) {}

  async run(options: RunOptions): Promise<RunResult> {
    const { store, logger, clock } = this.deps;
    const profile = this.deps.getProfile();
    const backupFolder = profile.destination.backupFolder;

    const lock = new LockManager(store, backupFolder, clock, {
      timeoutMin: profile.safety.lockTimeoutMin,
      platform: this.deps.platform,
      ...this.deps.lockOptions,
    });
    await lock.acquire();

    let createdFolder: string | null = null;
    try {
      const index = await loadIndex(store, backupFolder);
      const state = await loadState(store, backupFolder);
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

      createdFolder = `${backupFolder}/${plan.folder}`;
      const result = await this.execute(plan, profile, lock, index, state);
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
    previousState: BackupState,
  ): Promise<RunResult> {
    const { store } = this.deps;
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
    };
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
