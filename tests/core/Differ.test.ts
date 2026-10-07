import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/crypto/hash";
import {
  applyDiffToState,
  diffVault,
  emptyState,
  hasChanges,
  stateFromHashed,
  type HashedFile,
} from "../../src/core/Differ";
import type { BackupState, FileInfo } from "../../src/types";
import { MockClock } from "../mocks/MockClock";
import { MockVaultStore } from "../mocks/MockVaultStore";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const noYield = async (): Promise<void> => undefined;

/** Seeded PRNG so property failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Vault {
  store: MockVaultStore;
  clock: MockClock;
  files: FileInfo[];
}

async function build(
  contents: Record<string, string>,
  mtimes: Record<string, number> = {},
): Promise<Vault> {
  const clock = new MockClock(1000);
  const store = new MockVaultStore(clock);
  const files: FileInfo[] = [];
  for (const [path, text] of Object.entries(contents)) {
    clock.set(mtimes[path] ?? 1000);
    await store.writeBinary(path, enc(text));
    files.push({ path, size: enc(text).length, mtime: mtimes[path] ?? 1000 });
  }
  return { store, clock, files };
}

const stateOf = (v: Vault, texts: Record<string, string>): BackupState =>
  stateFromHashed(
    v.files.map((f) => ({ ...f, sha256: sha256Hex(enc(texts[f.path] as string)) })),
    1,
    1,
  );

describe("diffVault basics", () => {
  it("everything is added against an empty state, without reading any file", async () => {
    const v = await build({ "a.md": "a", "b.md": "bb" });
    let reads = 0;
    const read = v.store.readBinary.bind(v.store);
    v.store.readBinary = async (p) => (reads++, read(p));
    const d = await diffVault(v.store, v.files, emptyState(0, 1), noYield);
    expect(d.added.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(d.changed).toEqual([]);
    expect(reads).toBe(0);
  });

  it("identical mtime and size means unchanged, and the file is not read", async () => {
    const texts = { "a.md": "hello" };
    const v = await build(texts);
    const state = stateOf(v, texts);
    let reads = 0;
    const read = v.store.readBinary.bind(v.store);
    v.store.readBinary = async (p) => (reads++, read(p));
    const d = await diffVault(v.store, v.files, state, noYield);
    expect(d).toMatchObject({ added: [], changed: [], touched: [], deleted: [], unchanged: 1 });
    expect(reads).toBe(0);
    expect(hasChanges(d)).toBe(false);
  });

  it("size change with different content is changed, and carries the new hash", async () => {
    const old = { "a.md": "hello" };
    const state = stateOf(await build(old), old);
    const v = await build({ "a.md": "hello world" }, { "a.md": 2000 });
    const d = await diffVault(v.store, v.files, state, noYield);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.sha256).toBe(sha256Hex(enc("hello world")));
    expect(hasChanges(d)).toBe(true);
  });

  it("same-size edit with a new mtime is changed", async () => {
    const old = { "a.md": "hello" };
    const state = stateOf(await build(old), old);
    const v = await build({ "a.md": "world" }, { "a.md": 2000 });
    expect((await diffVault(v.store, v.files, state, noYield)).changed).toHaveLength(1);
  });

  it("new mtime but identical content is touched, not changed", async () => {
    const texts = { "a.md": "same" };
    const state = stateOf(await build(texts), texts);
    const v = await build(texts, { "a.md": 9999 });
    const d = await diffVault(v.store, v.files, state, noYield);
    expect(d.changed).toEqual([]);
    expect(d.touched).toHaveLength(1);
    expect(d.touched[0]!.mtime).toBe(9999);
    expect(hasChanges(d)).toBe(false);
  });

  it("files missing from the vault are deleted, sorted", async () => {
    const old = { "z.md": "1", "a.md": "2", "keep.md": "3" };
    const state = stateOf(await build(old), old);
    const v = await build({ "keep.md": "3" });
    const d = await diffVault(v.store, v.files, state, noYield);
    expect(d.deleted).toEqual(["a.md", "z.md"]);
    expect(d.unchanged).toBe(1);
  });

  it("a rename shows up as one delete plus one add", async () => {
    const old = { "old.md": "text" };
    const state = stateOf(await build(old), old);
    const v = await build({ "new.md": "text" });
    const d = await diffVault(v.store, v.files, state, noYield);
    expect(d.deleted).toEqual(["old.md"]);
    expect(d.added.map((f) => f.path)).toEqual(["new.md"]);
  });

  it("yields while hashing", async () => {
    const old = { "a.md": "1", "b.md": "2" };
    const state = stateOf(await build(old), old);
    const v = await build({ "a.md": "11", "b.md": "22" }, { "a.md": 5, "b.md": 5 });
    let yields = 0;
    await diffVault(v.store, v.files, state, async () => void yields++);
    expect(yields).toBe(2);
  });
});

describe("applyDiffToState / stateFromHashed", () => {
  it("removes deleted, refreshes touched, records packed hashes, stamps time", () => {
    const state: BackupState = {
      schemaVersion: 1,
      updatedAt: 1,
      files: {
        "gone.md": { mtime: 1, size: 1, sha256: "g" },
        "touch.md": { mtime: 1, size: 1, sha256: "t" },
        "same.md": { mtime: 1, size: 1, sha256: "s" },
      },
    };
    const touched: HashedFile = { path: "touch.md", size: 1, mtime: 50, sha256: "t" };
    const packed: HashedFile = { path: "new.md", size: 9, mtime: 60, sha256: "n" };
    const next = applyDiffToState(
      state,
      { added: [packed], changed: [], touched: [touched], deleted: ["gone.md"], unchanged: 1 },
      [packed],
      777,
    );
    expect(next.updatedAt).toBe(777);
    expect(Object.keys(next.files).sort()).toEqual(["new.md", "same.md", "touch.md"]);
    expect(next.files["touch.md"]).toEqual({ mtime: 50, size: 1, sha256: "t" });
    expect(next.files["new.md"]).toEqual({ mtime: 60, size: 9, sha256: "n" });
    expect(state.files["gone.md"]).toBeDefined(); // input not mutated
  });
});

describe("property: applying the diff reproduces the new vault state", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("seed %i", async (seed) => {
    const rand = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const names = Array.from({ length: 25 }, (_, i) => `d${i % 4}/f${i}.md`);

    // Old vault and its state.
    const oldTexts: Record<string, string> = {};
    for (const n of names) if (rand() < 0.7) oldTexts[n] = `v1-${n}-${Math.floor(rand() * 5)}`;
    const oldVault = await build(oldTexts);
    const oldState = stateOf(oldVault, oldTexts);

    // Random mutations: edit, touch only, delete, add.
    const newTexts: Record<string, string> = {};
    const newMtimes: Record<string, number> = {};
    for (const n of names) {
      const had = n in oldTexts;
      const roll = rand();
      if (had && roll < 0.4) continue; // untouched below
      if (had && roll < 0.55) {
        newTexts[n] = oldTexts[n] as string; // identical content, new mtime
        newMtimes[n] = 5000 + Math.floor(rand() * 100);
      } else if (had && roll < 0.75) {
        newTexts[n] = `${oldTexts[n]}-edited-${pick(["x", "yy", "zzz"])}`; // edited
        newMtimes[n] = 6000;
      } else if (!had && roll < 0.5) {
        newTexts[n] = `new-${n}`; // added
        newMtimes[n] = 7000;
      } // else: deleted (had) or still absent
    }
    for (const n of names)
      if (n in oldTexts && !(n in newTexts) && rand() < 0.5) newTexts[n] = oldTexts[n] as string; // untouched: keeps old mtime

    const newVault = await build(newTexts, newMtimes);
    // Untouched files must keep the mtime they had in the old vault.
    for (const f of newVault.files) {
      if (!(f.path in newMtimes)) f.mtime = 1000;
    }

    const diff = await diffVault(newVault.store, newVault.files, oldState, noYield);
    const packed: HashedFile[] = [...diff.added, ...diff.changed].map((f) => ({
      ...f,
      sha256: sha256Hex(enc(newTexts[f.path] as string)),
    }));
    const applied = applyDiffToState(oldState, diff, packed, 1);
    const expected = stateFromHashed(
      newVault.files.map((f) => ({ ...f, sha256: sha256Hex(enc(newTexts[f.path] as string)) })),
      1,
      1,
    );

    expect(applied.files).toEqual(expected.files);
    // And the classification is consistent with ground truth.
    for (const f of diff.added) expect(f.path in oldTexts).toBe(false);
    for (const p of diff.deleted) expect(p in newTexts).toBe(false);
    for (const f of diff.changed) expect(newTexts[f.path]).not.toBe(oldTexts[f.path]);
  });
});
