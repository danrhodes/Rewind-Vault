import { StorageError } from "../helpers/errors";
import { parentPath, type IVaultStore } from "./VaultStore";

/** Adds a line of text to the end of a note, creating the note (and folders) if needed. */
export interface ITextAppender {
  appendText(path: string, text: string): Promise<void>;
}

/** The part of Obsidian's `DataAdapter` the appender uses. */
export interface AppendAdapterLike {
  exists(path: string): Promise<boolean>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
}

/**
 * Appender backed by the adapter's own `append`, which adds to the file in one operation, so
 * it cannot overwrite an edit the user is making to the same note (a read-modify-write would).
 */
export function createTextAppender(adapter: AppendAdapterLike, store: IVaultStore): ITextAppender {
  return {
    async appendText(path, text) {
      try {
        if (await adapter.exists(path)) {
          await adapter.append(path, text);
        } else {
          await store.mkdir(parentPath(path));
          await adapter.write(path, text);
        }
      } catch (cause) {
        throw new StorageError(path, "Cannot append to", { cause });
      }
    },
  };
}
