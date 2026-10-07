import { sha256Hex } from "../crypto/hash";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupState, FileInfo, FileState } from "../types";

export type HashedFile = FileInfo & { sha256: string };

export interface DiffResult {
  /** Not in the last state. Not hashed here: the packer hashes what it actually stores. */
  added: FileInfo[];
  /** mtime or size differs from the last state and the content hash differs too. */
  changed: HashedFile[];
  /** mtime or size differs but the content is identical. Only the state needs refreshing. */
  touched: HashedFile[];
  /** In the last state but no longer in the vault. */
  deleted: string[];
  unchanged: number;
}

/**
 * Compare the current scan with the last known state (PLAN section 9). A file whose
 * mtime and size both match is trusted unchanged without being read. Anything else is
 * hashed to tell real edits from mere timestamp changes. A same-size edit that keeps its
 * mtime would go unnoticed: this is the usual cost of metadata-first diffing.
 */
export async function diffVault(
  store: IVaultStore,
  current: readonly FileInfo[],
  state: BackupState,
  yieldIfNeeded: () => Promise<void> = createYielder(),
): Promise<DiffResult> {
  const result: DiffResult = { added: [], changed: [], touched: [], deleted: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const file of current) {
    seen.add(file.path);
    const previous = state.files[file.path];
    if (!previous) {
      result.added.push(file);
    } else if (previous.mtime === file.mtime && previous.size === file.size) {
      result.unchanged++;
    } else {
      const sha256 = sha256Hex(await store.readBinary(file.path));
      const hashed = { ...file, sha256 };
      if (sha256 === previous.sha256) result.touched.push(hashed);
      else result.changed.push(hashed);
      await yieldIfNeeded();
    }
  }

  for (const path of Object.keys(state.files)) {
    if (!seen.has(path)) result.deleted.push(path);
  }
  result.deleted.sort();
  return result;
}

export function hasChanges(diff: DiffResult): boolean {
  return diff.added.length + diff.changed.length + diff.deleted.length > 0;
}

export function emptyState(updatedAt: number, schemaVersion: number): BackupState {
  return { schemaVersion, updatedAt, files: {} };
}

/**
 * State after a successful backup: previous state, minus deleted files, with touched
 * files refreshed and every packed (added or changed) file recorded with the hash that
 * was actually stored. Pure: returns a new object.
 */
export function applyDiffToState(
  state: BackupState,
  diff: DiffResult,
  packed: readonly HashedFile[],
  updatedAt: number,
): BackupState {
  const files: Record<string, FileState> = { ...state.files };
  for (const path of diff.deleted) delete files[path];
  for (const f of [...diff.touched, ...packed]) {
    files[f.path] = { mtime: f.mtime, size: f.size, sha256: f.sha256 };
  }
  return { schemaVersion: state.schemaVersion, updatedAt, files };
}

/** State for a full backup: exactly the files that were packed. */
export function stateFromHashed(
  packed: readonly HashedFile[],
  updatedAt: number,
  schemaVersion: number,
): BackupState {
  return applyDiffToState(
    emptyState(updatedAt, schemaVersion),
    { added: [], changed: [], touched: [], deleted: [], unchanged: 0 },
    packed,
    updatedAt,
  );
}
