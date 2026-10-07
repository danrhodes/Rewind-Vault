import type { AdapterLike } from "../../src/storage/VaultStore";

type Stat = { type: "file" | "folder"; size: number; mtime: number };

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * Behaves like the Obsidian DataAdapter: ArrayBuffer I/O, mkdir and write need an
 * existing parent folder, rename fails on an existing target.
 */
export class FakeAdapter implements AdapterLike {
  private readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  private readonly folders = new Set<string>([""]);
  private tick = 1;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.data.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (!this.folders.has(parent(path))) throw new Error(`ENOENT parent: ${path}`);
    this.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: this.tick++ });
  }

  async stat(path: string): Promise<Stat | null> {
    const f = this.files.get(path);
    if (f) return { type: "file", size: f.data.length, mtime: f.mtime };
    if (this.folders.has(path)) return { type: "folder", size: 0, mtime: 0 };
    return null;
  }

  async mkdir(path: string): Promise<void> {
    if (!this.folders.has(parent(path))) throw new Error(`ENOENT parent: ${path}`);
    this.folders.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (!this.folders.has(path)) throw new Error(`ENOENT: ${path}`);
    const kids = (p: string): boolean => p !== path && parent(p) === path;
    return { files: [...this.files.keys()].filter(kids), folders: [...this.folders].filter(kids) };
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!this.folders.has(path)) throw new Error(`ENOENT: ${path}`);
    const prefix = `${path}/`;
    const inside = [...this.files.keys(), ...this.folders].filter((p) => p.startsWith(prefix));
    if (inside.length > 0 && !recursive) throw new Error(`ENOTEMPTY: ${path}`);
    for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
    for (const d of [...this.folders]) {
      if (d === path || d.startsWith(prefix)) this.folders.delete(d);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw new Error(`ENOENT: ${from}`);
    if (await this.exists(to)) throw new Error(`EEXIST: ${to}`);
    if (!this.folders.has(parent(to))) throw new Error(`ENOENT parent: ${to}`);
    this.files.delete(from);
    this.files.set(to, f);
  }
}
