import type { IVaultStore } from "../storage/VaultStore";
import type { BackupEntry } from "../types";
import { loadIndex, sortedBackups } from "./BackupIndex";
import { resolveChain, type RestoreSource } from "./ChainResolver";

/** One file as it existed at a point in the backup history. */
export interface PointFile {
  path: string;
  size: number;
  mtime: number;
}

/** Intact backups, newest first: the moments the vault can be viewed at. */
export async function listPoints(store: IVaultStore, backupFolder: string): Promise<BackupEntry[]> {
  const index = await loadIndex(store, backupFolder);
  return sortedBackups(index).filter((b) => b.status === "ok");
}

/**
 * Every file the vault held at a backup, resolved through the full + differential chain, sorted
 * by path. Read-only: nothing is written and no file content is read.
 */
export async function listFilesAt(
  store: IVaultStore,
  backupFolder: string,
  source: RestoreSource,
): Promise<PointFile[]> {
  const index = await loadIndex(store, backupFolder);
  const chain = await resolveChain(store, backupFolder, index, source);
  return [...chain.files.values()]
    .map((f) => ({ path: f.path, size: f.entry.size, mtime: f.entry.mtime }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
