import { RestoreError } from "../helpers/errors";
import { writeAtomic } from "../storage/AtomicWriter";
import type { ResolvedFile } from "./ChainResolver";
import type { RestorePlan } from "./RestorePlan";
import { readFilesFromPart } from "./RestoreReader";
import { destinationPath, type RestoreContext } from "./RestoreTypes";

export interface RestoreBatchResult {
  /** "" for the vault, otherwise the restore folder used. */
  destinationRoot: string;
  backupId: string;
  created: number;
  replaced: number;
  unchanged: number;
  deleted: number;
  bytesWritten: number;
}

export interface RestoreBatchOptions {
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

  for (const group of groupByPart(plan.toWrite)) {
    for await (const { file, data } of readFilesFromPart(
      ctx.store,
      ctx.backupFolder,
      plan.chain,
      group,
      ctx.deriveMasterKey,
    )) {
      await writeAtomic(ctx.store, destinationPath(preview.destinationRoot, file.path), data);
      if (replacing.has(file.path)) result.replaced++;
      else result.created++;
      result.bytesWritten += data.length;
      await ctx.yieldIfNeeded();
    }
  }

  for (const path of preview.deletions) {
    await ctx.store.remove(destinationPath(preview.destinationRoot, path));
    result.deleted++;
  }
  ctx.logger.info(
    `Restored backup ${result.backupId}: ${result.created} created, ${result.replaced} replaced, ` +
      `${result.unchanged} unchanged, ${result.deleted} deleted`,
  );
  return result;
}
