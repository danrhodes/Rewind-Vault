import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageError } from "../../src/helpers/errors";
import {
  ExternalCopy,
  isValidExternalPath,
  loadNodeFs,
  type ExternalFs,
} from "../../src/storage/ExternalCopy";
import { MockLogger } from "../mocks/MockLogger";
import { MockVaultStore } from "../mocks/MockVaultStore";

/** In-memory fs that records the order of operations. */
class MemoryFs implements ExternalFs {
  files = new Map<string, Uint8Array>();
  log: string[] = [];
  failWriteOn: string | null = null;
  shortWrite = false;

  async mkdir(path: string): Promise<void> {
    this.log.push(`mkdir ${path}`);
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (this.failWriteOn && path.includes(this.failWriteOn)) throw new Error("disk full");
    this.files.set(path, this.shortWrite ? data.slice(0, 1) : data);
    this.log.push(`write ${path}`);
  }
  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) throw new Error("ENOENT");
    this.files.delete(from);
    this.files.set(to, data);
    this.log.push(`rename ${to}`);
  }
  async stat(path: string): Promise<{ size: number }> {
    const data = this.files.get(path);
    if (!data) throw new Error("ENOENT");
    return { size: data.length };
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

async function vaultWithBackup(): Promise<MockVaultStore> {
  const store = new MockVaultStore();
  await store.seed("backup/B1/manifest.json", '{"m":1}');
  await store.seed("backup/B1/part-001.zip", "zipdata-1");
  await store.seed("backup/B1/part-002.zip", "zipdata-2");
  return store;
}

describe("isValidExternalPath", () => {
  it.each(["/mnt/backup", "C:\\Backups\\vault", "D:/Backups", "\\\\nas\\share\\vault"])(
    "accepts %s",
    (p) => expect(isValidExternalPath(p)).toBe(true),
  );
  it.each(["", "  ", "relative/path", "backups", "../up", "/a/../b", "C:\\a\\..\\b", "/a\0b"])(
    "rejects %j",
    (p) => expect(isValidExternalPath(p)).toBe(false),
  );
});

describe("ExternalCopy", () => {
  it("copies every file of the backup folder and writes the manifest last", async () => {
    const fs = new MemoryFs();
    const copy = new ExternalCopy(await vaultWithBackup(), fs, new MockLogger());
    const result = await copy.copyBackup("backup", "B1", "/mnt/ext/");
    expect(result).toEqual({ files: 3, bytes: 7 + 9 + 9, destination: "/mnt/ext/B1" });
    const renames = fs.log.filter((l) => l.startsWith("rename"));
    expect(renames).toEqual([
      "rename /mnt/ext/B1/part-001.zip",
      "rename /mnt/ext/B1/part-002.zip",
      "rename /mnt/ext/B1/manifest.json",
    ]);
    expect(new TextDecoder().decode(fs.files.get("/mnt/ext/B1/part-002.zip"))).toBe("zipdata-2");
    expect([...fs.files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
  });

  it("leaves no manifest and no temp file when a write fails part way", async () => {
    const fs = new MemoryFs();
    fs.failWriteOn = "part-002";
    const copy = new ExternalCopy(await vaultWithBackup(), fs, new MockLogger());
    await expect(copy.copyBackup("backup", "B1", "/mnt/ext")).rejects.toBeInstanceOf(StorageError);
    expect(fs.files.has("/mnt/ext/B1/manifest.json")).toBe(false);
    expect([...fs.files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
  });

  it("detects a short write", async () => {
    const fs = new MemoryFs();
    fs.shortWrite = true;
    const copy = new ExternalCopy(await vaultWithBackup(), fs, new MockLogger());
    await expect(copy.copyBackup("backup", "B1", "/mnt/ext")).rejects.toBeInstanceOf(StorageError);
    expect(fs.files.size).toBe(0);
  });

  it("refuses a relative path and a folder without a manifest", async () => {
    const store = await vaultWithBackup();
    const copy = new ExternalCopy(store, new MemoryFs(), new MockLogger());
    await expect(copy.copyBackup("backup", "B1", "relative")).rejects.toBeInstanceOf(StorageError);
    await store.seed("backup/B2/part-001.zip", "x");
    await expect(copy.copyBackup("backup", "B2", "/mnt/ext")).rejects.toBeInstanceOf(StorageError);
  });
});

/** Node's modules, loaded without type declarations (the project builds for mobile too). */
interface NodeModules {
  fs: { promises: ExternalFs & Record<string, (...args: never[]) => Promise<unknown>> };
  os: { tmpdir(): string };
  path: { join(...parts: string[]): string };
}
async function nodeModules(): Promise<NodeModules> {
  const [fs, os, path] = await Promise.all([
    vi.importActual("node:fs"),
    vi.importActual("node:os"),
    vi.importActual("node:path"),
  ]);
  return { fs, os, path } as NodeModules;
}

describe("ExternalCopy with the real file system", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) {
      const { fs } = await nodeModules();
      await (fs.promises.rm as unknown as (p: string, o: object) => Promise<void>)(dir, {
        recursive: true,
        force: true,
      });
    }
    dir = "";
  });

  it("writes the files, replaces an earlier copy, and leaves nothing temporary behind", async () => {
    const { fs, os, path } = await nodeModules();
    const read = fs.promises.readFile as unknown as (p: string, enc: string) => Promise<string>;
    const list = fs.promises.readdir as unknown as (p: string) => Promise<string[]>;
    const makeDir = fs.promises.mkdtemp as unknown as (prefix: string) => Promise<string>;
    dir = await makeDir(path.join(os.tmpdir(), "rewind-ext-"));
    const store = await vaultWithBackup();
    const copy = new ExternalCopy(store, fs.promises, new MockLogger());
    await copy.copyBackup("backup", "B1", dir);
    await store.seed("backup/B1/part-001.zip", "changed!!");
    await copy.copyBackup("backup", "B1", dir);
    expect((await list(path.join(dir, "B1"))).sort()).toEqual([
      "manifest.json",
      "part-001.zip",
      "part-002.zip",
    ]);
    expect(await read(path.join(dir, "B1", "part-001.zip"), "utf8")).toBe("changed!!");
    expect(await read(path.join(dir, "B1", "manifest.json"), "utf8")).toBe('{"m":1}');
  });
});

describe("loadNodeFs", () => {
  it("is null where the runtime has no require (as on mobile)", () => {
    const g = globalThis as { require?: unknown };
    const saved = g.require;
    g.require = undefined;
    try {
      expect(loadNodeFs()).toBeNull();
    } finally {
      g.require = saved;
    }
  });

  it("is null when loading fs throws", () => {
    const g = globalThis as { require?: unknown };
    const saved = g.require;
    g.require = () => {
      throw new Error("no fs");
    };
    try {
      expect(loadNodeFs()).toBeNull();
    } finally {
      g.require = saved;
    }
  });
});
