import type { IVaultStore, StoreListing, StoreStat } from "../../src/storage/VaultStore";
import { parentPath, writeText } from "../../src/storage/VaultStore";
import { MockClock } from "./MockClock";

/** In-memory IVaultStore. Mirrors Obsidian: rename fails if the destination exists. */
export class MockVaultStore implements IVaultStore {
  private readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  private readonly folders = new Set<string>();

  constructor(private readonly clock: MockClock = new MockClock()) {}

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file.data.slice();
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.mkdir(parentPath(path));
    this.files.set(path, { data: data.slice(), mtime: this.clock.now() });
  }

  async stat(path: string): Promise<StoreStat | null> {
    const file = this.files.get(path);
    if (file) return { type: "file", size: file.data.length, mtime: file.mtime };
    if (this.folders.has(path)) return { type: "folder", size: 0, mtime: 0 };
    return null;
  }

  async mkdir(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }

  /** Immediate children only, as full paths, sorted. */
  async list(path: string): Promise<StoreListing> {
    const prefix = path ? `${path}/` : "";
    const direct = (p: string): boolean =>
      p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
    return {
      files: [...this.files.keys()].filter(direct).sort(),
      folders: [...this.folders].filter((p) => p !== path && direct(p)).sort(),
    };
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  async removeFolder(path: string): Promise<void> {
    if (!this.folders.has(path)) throw new Error(`ENOENT: ${path}`);
    const prefix = `${path}/`;
    for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
    for (const d of [...this.folders]) {
      if (d === path || d.startsWith(prefix)) this.folders.delete(d);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw new Error(`ENOENT: ${from}`);
    if (await this.exists(to)) throw new Error(`EEXIST: ${to}`);
    await this.mkdir(parentPath(to));
    this.files.delete(from);
    this.files.set(to, file);
  }

  /** Test helper: seed a text file. */
  seed(path: string, text: string): Promise<void> {
    return writeText(this, path, text);
  }
}
