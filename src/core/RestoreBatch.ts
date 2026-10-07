import { CancelledError, RestoreError, RewindError } from "../helpers/errors";
import { writeAtomic } from "../storage/AtomicWriter";
import type { ResolvedFile } from "./ChainResolver";
import type { RestorePlan } from "./RestorePlan";
import { readFilesFromPart } from "./RestoreReader";
import {
  destinationPath,
  type RestoreContext,
  type RestoreControl,
  type RestoreProgress,
} from "./RestoreTypes";

export interface RestoreBatchResult {
  /** "" for the vault, otherwise the restore folder used. */
  destinationRoot: string;
  backupId: string;
  created: number;
  replaced: number;
  unchanged: number;
  deleted: number;
  /** Pre-restore snapshot: its backup id, "up-to-date" if the latest backup already matched, absent if none was needed. */
  snapshot?: string;
  bytesWritten: number;
}

export interface RestoreBatchOptions extends RestoreControl {
  /** Replace files whose content differs. Without it, any difference aborts before writing. */
  overwrite?: boolean;
}

function groupByPart(files: ResolvedFile[]): ResolvedFile[][] {
  const groups = new Map<string, ResolvedFile[]>();
  for (const f of files) {
    const key = `${f.folder}/${f.entry.part}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()];
}

/** Back up the live vault before it is changed. A restore never proceeds without it. */
async function takeSnapshot(ctx: RestoreContext): Promise<string> {
  if (!ctx.safetySnapshot) {
    throw new RestoreError(
      "A safety snapshot is required before restoring into the vault, but none is available. " +
        "Nothing was written. (It can be turned off in settings: Safety > pre-restore snapshot.)",
    );
  }
  try {
    const snap = await ctx.safetySnapshot();
    ctx.logger.info(
      snap
        ? `Pre-restore snapshot ${snap.backupId}`
        : "Pre-restore snapshot not needed: up to date",
    );
    return snap?.backupId ?? "up-to-date";
  } catch (error) {
    if (error instanceof RewindError && error.code === "cancelled") throw error;
    throw new RestoreError("The safety snapshot failed, so nothing was restored", {
      cause: error,
    });
  }
}

/**
 * Carry out a planned restore. Refuses up front (writing nothing) if it would replace
 * differing files without `overwrite`. Each part is read once; every file is hash-checked
 * and written atomically, so an interruption leaves only whole files behind.
 */
export async function executeRestore(
  ctx: RestoreContext,
  plan: RestorePlan,
  options: RestoreBatchOptions = {},
): Promise<RestoreBatchResult> {
  const { preview } = plan;
  if (preview.changes.length > 0 && !options.overwrite) {
    throw new RestoreError(
      `${preview.changes.length} file(s) at the destination differ from the backup (first: ` +
        `${destinationPath(preview.destinationRoot, preview.changes[0]?.path ?? "")}); ` +
        `overwrite was not chosen, nothing was written`,
    );
  }
  if (preview.deletions.length > 0 && !options.overwrite) {
    throw new RestoreError(
      `${preview.deletions.length} file(s) would be deleted; overwrite was not chosen, nothing was written`,
    );
  }
  const checkCancelled = (): void => {
    if (options.isCancelled?.() === true) throw new CancelledError("Restore cancelled");
  };
  const progress: RestoreProgress = {
    phase: "writing",
    filesDone: 0,
    filesTotal: plan.toWrite.length + preview.deletions.length,
    bytesDone: 0,
    bytesTotal: preview.bytesToWrite,
  };
  const report = (patch: Partial<RestoreProgress>): void => {
    Object.assign(progress, patch);
    try {
      options.onProgress?.({ ...progress });
    } catch {
      // A broken progress listener must never fail a restore.
    }
  };
  checkCancelled();
  const replacing = new Set(preview.changes.map((c) => c.path));
  const result: RestoreBatchResult = {
    destinationRoot: preview.destinationRoot,
    backupId: preview.source.id,
    created: 0,
    replaced: 0,
    unchanged: preview.unchanged,
    deleted: 0,
    bytesWritten: 0,
  };

  if (
    preview.destinationRoot === "" &&
    plan.toWrite.length + preview.deletions.length > 0 &&
    ctx.profile.safety.preRestoreSnapshot
  ) {
    report({ phase: "snapshot", currentFile: undefined });
    result.snapshot = await takeSnapshot(ctx);
    report({ phase: "writing" });
  }

  for (const group of groupByPart(plan.toWrite)) {
    for await (const { file, data } of readFilesFromPart(
      ctx.store,
      ctx.backupFolder,
      plan.chain,
      group,
      ctx.deriveMasterKey,
    )) {
      checkCancelled();
      report({ currentFile: file.path });
      await writeAtomic(ctx.store, destinationPath(preview.destinationRoot, file.path), data);
      if (replacing.has(file.path)) result.replaced++;
      else result.created++;
      result.bytesWritten += data.length;
      report({ filesDone: progress.filesDone + 1, bytesDone: result.bytesWritten });
      await ctx.yieldIfNeeded();
    }
  }

  report({ phase: "deleting" });
  for (const path of preview.deletions) {
    checkCancelled();
    report({ currentFile: path });
    await ctx.store.remove(destinationPath(preview.destinationRoot, path));
    result.deleted++;
    report({ filesDone: progress.filesDone + 1 });
  }
  ctx.logger.info(
    `Restored backup ${result.backupId}: ${result.created} created, ${result.replaced} replaced, ` +
      `${result.unchanged} unchanged, ${result.deleted} deleted`,
  );
  return result;
}
