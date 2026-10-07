import { readBackupFolder } from "./readBackup";
import type { IVaultStore } from "../../src/storage/VaultStore";
import type { BackupIndex } from "../../src/types";

/**
 * Independent restore-to-memory used by tests: apply backups in order, entries overwrite,
 * tombstones delete. `ids` are applied oldest first; a full backup resets everything before it.
 */
export async function reconstruct(
  store: IVaultStore,
  backupFolder: string,
  ids: string[],
): Promise<Map<string, Uint8Array>> {
  const state = new Map<string, Uint8Array>();
  for (const id of ids) {
    const { manifest, files } = await readBackupFolder(store, `${backupFolder}/${id}`);
    if (manifest.type === "full") state.clear(); // a full backup starts from scratch
    for (const t of manifest.tombstones) state.delete(t.path);
    for (const [path, data] of files) state.set(path, data);
  }
  return state;
}

export const idsOf = (index: BackupIndex): string[] =>
  [...index.backups].sort((a, b) => a.createdAt - b.createdAt).map((b) => b.id);
