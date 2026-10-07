import { StorageError } from "../helpers/errors";
import type { IVaultStore, StoreListing, StoreStat } from "../storage/VaultStore";

/**
 * Wraps a store so that nothing inside an existing backup folder can be written, renamed
 * or removed. Used by non-destructive runs: new backups are added next to old ones, and
 * a bug anywhere in the engine cannot touch what is already there. Reads are unrestricted. Violations always surface as rejected promises.
 */
export function guardStore(
  store: IVaultStore,
  backupFolder: string,
  protectedFolders: ReadonlySet<string>,
): IVaultStore {
  const roots = [...protectedFolders].map((name) => `${backupFolder}/${name}`);
  const isProtected = (path: string): boolean =>
    roots.some((root) => path === root || path.startsWith(`${root}/`));

  const check = (path: string, action: string): void => {
    if (isProtected(path)) {
      throw new StorageError(path, `Non-destructive mode refuses to ${action} an existing backup`);
    }
  };

  return {
    exists: (p): Promise<boolean> => store.exists(p),
    readBinary: (p): Promise<Uint8Array> => store.readBinary(p),
    stat: (p): Promise<StoreStat | null> => store.stat(p),
    list: (p): Promise<StoreListing> => store.list(p),
    mkdir: (p): Promise<void> => store.mkdir(p),
    async writeBinary(path, data) {
      check(path, "write into");
      await store.writeBinary(path, data);
    },
    async remove(path) {
      check(path, "remove");
      await store.remove(path);
    },
    async removeFolder(path) {
      check(path, "remove");
      await store.removeFolder(path);
    },
    async rename(from, to) {
      check(from, "move");
      check(to, "overwrite");
      await store.rename(from, to);
    },
  };
}
