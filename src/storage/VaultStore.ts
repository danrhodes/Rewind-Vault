import { StorageError } from "../helpers/errors";

export interface StoreStat {
  type: "file" | "folder";
  size: number;
  mtime: number;
}

export interface StoreListing {
  /** Full vault-relative paths of immediate children. */
  files: string[];
  folders: string[];
}

/**
 * Everything the engines need from the vault. Paths are vault-relative, use "/", and
 * have no leading slash. `rename` fails if the destination exists (as in Obsidian).
 */
export interface IVaultStore {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<StoreStat | null>;
  /** Creates the folder and any missing parents. No-op if it exists. */
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<StoreListing>;
  remove(path: string): Promise<void>;
  /** Removes a folder and everything inside it. */
  removeFolder(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** The subset of Obsidian's `DataAdapter` we use. Lets tests supply a fake. */
export interface AdapterLike {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  stat(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy.buffer;
}

async function wrap<T>(path: string, action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new StorageError(path, `Cannot ${action}`, { cause });
  }
}

/** IVaultStore backed by `app.vault.adapter`. Mobile-safe: no Node APIs. */
export class AdapterVaultStore implements IVaultStore {
  constructor(private readonly adapter: AdapterLike) {}

  exists(path: string): Promise<boolean> {
    return wrap(path, "check existence of", () => this.adapter.exists(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await wrap(path, "read", () => this.adapter.readBinary(path));
    return new Uint8Array(buf);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.mkdir(parentPath(path));
    await wrap(path, "write", () => this.adapter.writeBinary(path, toArrayBuffer(data)));
  }

  stat(path: string): Promise<StoreStat | null> {
    return wrap(path, "stat", async () => {
      const s = await this.adapter.stat(path);
      return s ? { type: s.type, size: s.size, mtime: s.mtime } : null;
    });
  }

  async mkdir(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const target = current;
      await wrap(target, "create folder", async () => {
        if (!(await this.adapter.exists(target))) await this.adapter.mkdir(target);
      });
    }
  }

  list(path: string): Promise<StoreListing> {
    return wrap(path, "list", async () => {
      const { files, folders } = await this.adapter.list(path);
      return { files: [...files].sort(), folders: [...folders].sort() };
    });
  }

  remove(path: string): Promise<void> {
    return wrap(path, "remove", () => this.adapter.remove(path));
  }

  removeFolder(path: string): Promise<void> {
    return wrap(path, "remove folder", () => this.adapter.rmdir(path, true));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.mkdir(parentPath(to));
    await wrap(from, "rename", () => this.adapter.rename(from, to));
  }
}

export async function readText(store: IVaultStore, path: string): Promise<string> {
  return new TextDecoder().decode(await store.readBinary(path));
}

export async function writeText(store: IVaultStore, path: string, text: string): Promise<void> {
  await store.writeBinary(path, new TextEncoder().encode(text));
}
