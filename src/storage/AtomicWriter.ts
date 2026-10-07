import { FILE_NAMES } from "../constants";
import { StorageError } from "../helpers/errors";
import type { IVaultStore } from "./VaultStore";

const BACKUP_SUFFIX = ".bak";

const tempPath = (path: string): string => `${path}${FILE_NAMES.tempSuffix}`;
const backupPath = (path: string): string => `${path}${BACKUP_SUFFIX}`;

/**
 * Replace `path` so a crash at any point leaves either the old or the new content,
 * never a missing or half-written file.
 *
 * Steps: write `path.tmp` -> verify size -> move old to `path.bak` -> move tmp into
 * place -> delete `.bak`. If the process dies between the two moves, `recoverAtomic`
 * restores the `.bak`.
 */
export async function writeAtomic(
  store: IVaultStore,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const tmp = tempPath(path);
  const bak = backupPath(path);

  // Clear leftovers from an earlier crash before starting.
  await recoverAtomic(store, path);

  await store.writeBinary(tmp, data);
  const written = await store.stat(tmp);
  if (!written || written.size !== data.length) {
    throw new StorageError(path, "Temporary file was not written completely");
  }

  const hadOld = await store.exists(path);
  if (hadOld) await store.rename(path, bak);
  await store.rename(tmp, path);
  if (hadOld) await store.remove(bak);
}

export async function writeAtomicText(
  store: IVaultStore,
  path: string,
  text: string,
): Promise<void> {
  await writeAtomic(store, path, new TextEncoder().encode(text));
}

/**
 * Repair state left by an interrupted `writeAtomic`. Safe to call at any time.
 * - Target missing but `.bak` present: the old file is restored (the `.tmp` may be incomplete).
 * - Target present: stale `.tmp` and `.bak` are removed.
 */
export async function recoverAtomic(store: IVaultStore, path: string): Promise<void> {
  const tmp = tempPath(path);
  const bak = backupPath(path);
  const hasTarget = await store.exists(path);
  const hasBak = await store.exists(bak);

  if (!hasTarget && hasBak) {
    await store.rename(bak, path);
  } else if (hasBak) {
    await store.remove(bak);
  }
  if (await store.exists(tmp)) await store.remove(tmp);
}
