import { describe, expect, it } from "vitest";
import { recoverAtomic, writeAtomic, writeAtomicText } from "../../src/storage/AtomicWriter";
import type { IVaultStore, StoreListing, StoreStat } from "../../src/storage/VaultStore";
import { readText } from "../../src/storage/VaultStore";
import { MockVaultStore } from "../mocks/MockVaultStore";

/**
 * Wraps a store and "kills the process" at the Nth mutating operation. A failing
 * writeBinary leaves half the bytes behind, like a crash mid-write. After the crash
 * every call throws until `revive()` simulates a restart.
 */
class CrashingStore implements IVaultStore {
  private ops = 0;
  private dead = false;
  constructor(
    private readonly inner: MockVaultStore,
    private crashAt: number,
  ) {}

  /** Simulates a restart: the process is alive again and no further crash is scheduled. */
  revive(): void {
    this.dead = false;
    this.crashAt = Number.POSITIVE_INFINITY;
  }

  private alive(): void {
    if (this.dead) throw new Error("process is dead");
  }

  private mutate(): boolean {
    this.alive();
    this.ops++;
    if (this.ops === this.crashAt) {
      this.dead = true;
      return true;
    }
    return false;
  }

  exists(p: string): Promise<boolean> {
    this.alive();
    return this.inner.exists(p);
  }
  readBinary(p: string): Promise<Uint8Array> {
    this.alive();
    return this.inner.readBinary(p);
  }
  stat(p: string): Promise<StoreStat | null> {
    this.alive();
    return this.inner.stat(p);
  }
  list(p: string): Promise<StoreListing> {
    this.alive();
    return this.inner.list(p);
  }
  mkdir(p: string): Promise<void> {
    this.alive();
    return this.inner.mkdir(p);
  }
  async writeBinary(p: string, d: Uint8Array): Promise<void> {
    if (this.mutate()) {
      await this.inner.writeBinary(p, d.slice(0, Math.floor(d.length / 2)));
      throw new Error("crash during write");
    }
    await this.inner.writeBinary(p, d);
  }
  async remove(p: string): Promise<void> {
    if (this.mutate()) throw new Error("crash before remove");
    await this.inner.remove(p);
  }
  async removeFolder(p: string): Promise<void> {
    if (this.mutate()) throw new Error("crash before removeFolder");
    await this.inner.removeFolder(p);
  }
  async rename(a: string, b: string): Promise<void> {
    if (this.mutate()) throw new Error("crash before rename");
    await this.inner.rename(a, b);
  }
}

const OLD = "old content that must survive";
const NEW = "brand new content, longer than the old one";

describe("writeAtomic", () => {
  it("creates a new file and leaves no temp or backup files", async () => {
    const s = new MockVaultStore();
    await writeAtomicText(s, "backup/index.json", "{}");
    expect(await readText(s, "backup/index.json")).toBe("{}");
    expect((await s.list("backup")).files).toEqual(["backup/index.json"]);
  });

  it("replaces an existing file", async () => {
    const s = new MockVaultStore();
    await s.seed("f.json", OLD);
    await writeAtomicText(s, "f.json", NEW);
    expect(await readText(s, "f.json")).toBe(NEW);
    expect((await s.list("")).files).toEqual(["f.json"]);
  });

  it("recovers from leftovers of an earlier crash before writing", async () => {
    const s = new MockVaultStore();
    await s.seed("f.json", OLD);
    await s.seed("f.json.tmp", "half");
    await s.seed("f.json.bak", "stale");
    await writeAtomicText(s, "f.json", NEW);
    expect(await readText(s, "f.json")).toBe(NEW);
    expect((await s.list("")).files).toEqual(["f.json"]);
  });
});

describe("fault injection: crash at every step", () => {
  // Replacing an existing file performs 4 mutating operations:
  // write tmp, rename old->bak, rename tmp->target, remove bak.
  it.each([1, 2, 3, 4])("crash at mutating op %i never loses or corrupts the file", async (n) => {
    const mock = new MockVaultStore();
    await mock.seed("data/f.json", OLD);
    const store = new CrashingStore(mock, n);

    await expect(writeAtomicText(store, "data/f.json", NEW)).rejects.toThrow();

    // Restart: recovery runs, then the file must be fully old or fully new.
    store.revive();
    await recoverAtomic(mock, "data/f.json");
    const content = await readText(mock, "data/f.json");
    expect([OLD, NEW]).toContain(content);
    expect((await mock.list("data")).files).toEqual(["data/f.json"]);
  });

  it("crash before the swap keeps the old content exactly", async () => {
    for (const n of [1, 2]) {
      const mock = new MockVaultStore();
      await mock.seed("f.json", OLD);
      const store = new CrashingStore(mock, n);
      await expect(writeAtomicText(store, "f.json", NEW)).rejects.toThrow();
      // Even without running recovery the old data is reachable:
      const direct = (await mock.exists("f.json"))
        ? await readText(mock, "f.json")
        : await readText(mock, "f.json.bak");
      expect(direct).toBe(OLD);
    }
  });

  it("crash while creating a brand new file leaves nothing usable half-written at the target", async () => {
    const mock = new MockVaultStore();
    const store = new CrashingStore(mock, 1);
    await expect(writeAtomic(store, "new.json", new TextEncoder().encode(NEW))).rejects.toThrow();
    store.revive();
    await recoverAtomic(mock, "new.json");
    expect(await mock.exists("new.json")).toBe(false);
    expect(await mock.exists("new.json.tmp")).toBe(false);
  });
});

describe("recoverAtomic", () => {
  it("restores .bak when the target is missing", async () => {
    const s = new MockVaultStore();
    await s.seed("f.json.bak", OLD);
    await s.seed("f.json.tmp", "partial");
    await recoverAtomic(s, "f.json");
    expect(await readText(s, "f.json")).toBe(OLD);
    expect(await s.exists("f.json.tmp")).toBe(false);
  });

  it("is a no-op on a clean state", async () => {
    const s = new MockVaultStore();
    await s.seed("f.json", OLD);
    await recoverAtomic(s, "f.json");
    expect(await readText(s, "f.json")).toBe(OLD);
  });
});
