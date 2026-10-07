import { sha256Hex } from "../crypto/hash";
import { BrokenChainError, RestoreError } from "../helpers/errors";
import { loadIndex } from "./BackupIndex";
import { resolveChain, type ResolvedChain, type ResolvedFile } from "./ChainResolver";
import {
  destinationPath,
  inScope,
  normaliseScope,
  type PreviewItem,
  type RestoreContext,
  type RestorePreview,
  type RestoreRequest,
} from "./RestoreTypes";
import { scanOptionsFromProfile, scanVault } from "./Scanner";

export interface RestorePlan {
  preview: RestorePreview;
  chain: ResolvedChain;
  /** Files to write (additions then changes); identical files are left out. */
  toWrite: ResolvedFile[];
}

/** True when the file at `path` differs from the version the backup holds. */
export async function fileDiffers(
  ctx: RestoreContext,
  path: string,
  currentSize: number,
  file: ResolvedFile,
): Promise<boolean> {
  if (currentSize !== file.entry.size) return true;
  return sha256Hex(await ctx.store.readBinary(path)) !== file.entry.sha256;
}

/** Fail early if a part file needed for these files is missing. */
export async function assertPartsPresent(
  ctx: RestoreContext,
  files: ResolvedFile[],
): Promise<void> {
  const checked = new Set<string>();
  for (const f of files) {
    const partPath = `${ctx.backupFolder}/${f.folder}/${f.entry.part}`;
    if (checked.has(partPath)) continue;
    checked.add(partPath);
    if (!(await ctx.store.exists(partPath))) {
      throw new BrokenChainError(`Backup ${f.backupId} is missing ${f.entry.part}`);
    }
  }
}

export function destinationRoot(ctx: RestoreContext, request: RestoreRequest, id: string): string {
  return request.destination.kind === "vault"
    ? ""
    : `${ctx.profile.destination.restoreFolder}/${id}`;
}

/**
 * Work out what a restore would do without changing anything: resolve the chain, pick the
 * files in scope, compare each with what is at the destination.
 */
export async function planRestore(
  ctx: RestoreContext,
  request: RestoreRequest,
): Promise<RestorePlan> {
  const { store } = ctx;
  const scope = normaliseScope(request.scope);

  const index = await loadIndex(store, ctx.backupFolder);
  const chain = await resolveChain(store, ctx.backupFolder, index, request.source);
  const wanted = [...chain.files.values()]
    .filter((f) => inScope(scope, f.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (scope.kind === "file" && wanted.length === 0) {
    throw new RestoreError(`"${scope.path}" is not in backup ${chain.target.id}`);
  }
  if (scope.kind === "files") {
    const found = new Set(wanted.map((f) => f.path));
    const missing = scope.paths.find((p) => !found.has(p));
    if (missing !== undefined) {
      throw new RestoreError(`"${missing}" is not in backup ${chain.target.id}`);
    }
  }
  await assertPartsPresent(ctx, wanted);

  const root = destinationRoot(ctx, request, chain.target.id);
  const preview: RestorePreview = {
    source: chain.target,
    destinationRoot: root,
    additions: [],
    changes: [],
    deletions: [],
    unchanged: 0,
    bytesToWrite: 0,
  };
  const additions: ResolvedFile[] = [];
  const changes: ResolvedFile[] = [];

  for (const file of wanted) {
    const item: PreviewItem = { path: file.path, size: file.entry.size, backupId: file.backupId };
    const target = destinationPath(root, file.path);
    const current = await store.stat(target);
    if (current && current.type !== "file") {
      throw new RestoreError(`Cannot restore ${target}: a folder is in the way`);
    }
    if (!current) {
      preview.additions.push(item);
      additions.push(file);
      preview.bytesToWrite += item.size;
    } else if (await fileDiffers(ctx, target, current.size, file)) {
      preview.changes.push({ ...item, currentSize: current.size });
      changes.push(file);
      preview.bytesToWrite += item.size;
    } else {
      preview.unchanged++;
    }
    await ctx.yieldIfNeeded();
  }

  if (
    request.deleteExtraneous &&
    request.destination.kind === "vault" &&
    scope.kind !== "file" &&
    scope.kind !== "files"
  ) {
    const keep = new Set(wanted.map((f) => f.path));
    const live = await scanVault(store, scanOptionsFromProfile(ctx.profile), ctx.yieldIfNeeded);
    preview.deletions = live.map((f) => f.path).filter((p) => inScope(scope, p) && !keep.has(p));
  }
  return { preview, chain, toWrite: [...additions, ...changes] };
}
