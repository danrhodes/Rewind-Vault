import { MockClock } from "./MockClock";

export interface MockStat {
  type: "file" | "folder";
  size: number;
  mtime: number;
}

/**
 * In-memory vault adapter with the operations listed in T-018:
 * read/write binary, list, stat, mkdir, remove, rename. Paths use "/" and have no leading slash.
 */
export class MockVaultStore {
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
    await this.mkdir(parentOf(path));
    this.files.set(path, { data: data.slice(), mtime: this.clock.now() });
  }

  async stat(path: string): Promise<MockStat | null> {
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

  /** Immediate children only. Returns full paths, files then folders, sorted. */
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
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

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw new Error(`ENOENT: ${from}`);
    await this.mkdir(parentOf(to));
    this.files.delete(from);
    this.files.set(to, file);
  }

  /** Test helper: seed a text file. */
  async seed(path: string, text: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(text));
  }
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
