import { RECOVERY_SUFFIX, buildRecord } from "./RecoveryRecord";
import { ENCRYPTION, SCHEMA_VERSION } from "../constants";
import { signManifest } from "../crypto/sign";
import type { IClock } from "../helpers/time";
import { writeAtomic } from "../storage/AtomicWriter";
import type { IVaultStore } from "../storage/VaultStore";
import type {
  BackupIndex,
  BackupState,
  Manifest,
  ManifestEntry,
  ManifestPart,
  PlatformKind,
  SettingsProfile,
} from "../types";
import { addBackup, entryFromManifest, saveIndex } from "./BackupIndex";
import type { RunPlan } from "./BackupPlanner";
import { saveState } from "./BackupState";
import { clearCheckpoint, saveCheckpoint, type CheckpointData } from "./Checkpoint";
import { applyDiffToState, stateFromHashed, type HashedFile } from "./Differ";
import type { LockManager } from "./LockManager";
import { createManifest, saveManifest } from "./Manifest";
import { packPart } from "./Packer";
import type { RunControl } from "./RunControl";
import type { CompletedResult } from "./RunTypes";
import { partName } from "./Splitter";

export interface ExecContext {
  store: IVaultStore;
  profile: SettingsProfile;
  plan: RunPlan;
  lock: LockManager;
  control: RunControl;
  clock: IClock;
  platform: PlatformKind;
  pluginVersion: string;
  index: BackupIndex;
  previousState: BackupState;
  /** Null for unencrypted backups. */
  keys: { encryptionKey: CryptoKey; hmacKey: Uint8Array; keyCheck: string } | null;
  yieldIfNeeded: () => Promise<void>;
  nonDestructive: boolean;
  /** Continue an interrupted run: its finished parts are kept and not packed again. */
  resume?: CheckpointData;
}

/**
 * Pack and write every part, then commit: manifest, index, state, in that order. Until the
 * manifest is saved the backup does not exist; the caller deletes the folder on any error.
 * Cancellation is honoured up to the manifest write and ignored after it.
 */
export async function executePlan(ctx: ExecContext): Promise<CompletedResult> {
  const { store, profile, plan, control } = ctx;
  const backupFolder = profile.destination.backupFolder;
  const folderPath = `${backupFolder}/${plan.folder}`;
  await store.mkdir(folderPath);

  const parts: ManifestPart[] = [...(ctx.resume?.parts ?? [])];
  const entries: ManifestEntry[] = [...(ctx.resume?.entries ?? [])];
  const packed: HashedFile[] = entries.map(({ path, size, mtime, sha256 }) => ({
    path,
    size,
    mtime,
    sha256,
  }));
  const skippedFiles: string[] = [...(ctx.resume?.skippedFiles ?? [])];
  let bytes = ctx.resume?.bytes ?? 0;
  const startAt = ctx.resume?.nextPartIndex ?? 0;

  const checkpoint = (nextPartIndex: number): Promise<void> =>
    saveCheckpoint(store, backupFolder, {
      schemaVersion: SCHEMA_VERSION.checkpoint,
      plan,
      nextPartIndex,
      parts,
      entries,
      skippedFiles,
      bytes,
      savedAt: ctx.clock.now(),
    });
  if (startAt === 0) await checkpoint(0);

  // Progress counters start from what a resumed run has already done.
  for (const done of plan.parts.slice(0, startAt).flat()) control.fileDone(done.path, done.size);

  for (const [i, planned] of plan.parts.entries()) {
    if (i < startAt) continue;
    control.assertNotCancelled();
    await ctx.lock.refresh();
    control.update({ phase: "packing", partIndex: i + 1 });
    const actions = new Map(planned.map((f) => [f.path, f.action]));

    const part = await packPart(
      store,
      planned,
      {
        compressionLevel: profile.zip.compressionLevel,
        encryptionKey: ctx.keys?.encryptionKey,
        chunkSize: profile.misc.chunkSizeKb * 1024,
      },
      ctx.yieldIfNeeded,
      () => control.isCancelled,
      (file) => control.fileDone(file.path, file.size),
    );
    skippedFiles.push(...part.skipped);
    if (part.entries.length === 0) {
      await checkpoint(i + 1);
      continue;
    }

    const name = partName(parts.length + 1);
    await writeAtomic(store, `${folderPath}/${name}`, part.data);
    if (profile.zip.recoveryPercent > 0) {
      const record = await buildRecord(part.data, profile.zip.recoveryPercent, ctx.yieldIfNeeded);
      if (record) await writeAtomic(store, `${folderPath}/${name}${RECOVERY_SUFFIX}`, record);
    }
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
    await checkpoint(i + 1);
  }

  control.assertNotCancelled();
  control.update({ phase: "finalizing", currentFile: undefined });

  const manifest: Manifest = {
    ...createManifest({
      id: plan.id,
      type: plan.type,
      baseId: plan.baseId,
      createdAt: plan.createdAt,
      pluginVersion: ctx.pluginVersion,
      platform: ctx.platform,
      encryption: {
        enabled: plan.encryption.enabled,
        kdf: ENCRYPTION.kdf,
        iterations: plan.encryption.iterations,
        salt: plan.encryption.salt,
        algo: ENCRYPTION.algo,
        ...(ctx.keys ? { keyCheck: ctx.keys.keyCheck } : {}),
      },
    }),
    parts,
    entries,
    tombstones: plan.tombstones,
    status: "ok",
  };
  if (ctx.keys) manifest.hmac = await signManifest(manifest, ctx.keys.hmacKey);

  // Commit point. After this line the backup exists and cancellation is no longer checked.
  await saveManifest(store, folderPath, manifest);
  await saveIndex(
    store,
    backupFolder,
    addBackup(ctx.index, entryFromManifest(manifest, plan.folder, bytes)),
  );

  const now = ctx.clock.now();
  const nextState =
    plan.type === "full"
      ? stateFromHashed(packed, now, ctx.previousState.schemaVersion)
      : applyDiffToState(
          ctx.previousState,
          { added: [], changed: [], touched: plan.touched, deleted: plan.deleted, unchanged: 0 },
          packed,
          now,
        );
  try {
    await saveState(store, backupFolder, nextState);
  } catch (error) {
    // The folder is about to be deleted by the caller, so the index must not point at it.
    await saveIndex(store, backupFolder, ctx.index).catch(() => undefined);
    throw error;
  }
  await clearCheckpoint(store, backupFolder);

  return {
    status: "completed",
    backupId: plan.id,
    type: plan.type,
    fileCount: entries.length,
    bytes,
    skippedFiles: [...plan.skippedOverMax, ...skippedFiles],
    forcedFullReason: plan.forcedFullReason,
    nonDestructive: ctx.nonDestructive,
  };
}

/**
 * A differential run found nothing to back up. No backup is created, but files whose
 * only change was a new timestamp are recorded in state.json so they are not hashed
 * again on every later run.
 */
export async function skipUnchanged(
  store: IVaultStore,
  backupFolder: string,
  plan: RunPlan,
  state: BackupState,
  now: number,
): Promise<void> {
  if (plan.touched.length === 0) return;
  const refreshed = applyDiffToState(
    state,
    { added: [], changed: [], touched: plan.touched, deleted: [], unchanged: 0 },
    [],
    now,
  );
  await saveState(store, backupFolder, refreshed);
}
