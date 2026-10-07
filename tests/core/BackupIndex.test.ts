import { describe, expect, it } from "vitest";
import {
  addBackup,
  chainFor,
  emptyIndex,
  entryFromManifest,
  findBackup,
  indexPath,
  loadIndex,
  removeBackup,
  saveIndex,
  sortedBackups,
  updateBackup,
  validateIndex,
} from "../../src/core/BackupIndex";
import { createManifest } from "../../src/core/Manifest";
import { ManifestError } from "../../src/helpers/errors";
import type { BackupEntry, BackupIndex } from "../../src/types";
import { MockVaultStore } from "../mocks/MockVaultStore";

const entry = (id: string, createdAt: number, extra: Partial<BackupEntry> = {}): BackupEntry => ({
  id,
  type: "full",
  baseId: null,
  createdAt,
  status: "ok",
  pinned: false,
  size: 10,
  folder: id,
  ...extra,
});
const diff = (id: string, createdAt: number, baseId: string): BackupEntry =>
  entry(id, createdAt, { type: "diff", baseId });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("index validation", () => {
  it("accepts a valid index and keeps optional label", () => {
    const idx: BackupIndex = {
      schemaVersion: 1,
      backups: [entry("a", 1, { pinned: true, label: "Before refactor" }), diff("b", 2, "a")],
    };
    expect(validateIndex(clone(idx))).toEqual(idx);
  });

  const bad: [string, (i: BackupIndex) => void, string][] = [
    ["duplicate ids", (i) => void i.backups.push(entry("a", 5)), "duplicate id"],
    [
      "bad status",
      (i) => void ((i.backups[0] as unknown as Record<string, string>).status = "x"),
      "status",
    ],
    [
      "non-boolean pinned",
      (i) => void ((i.backups[0] as unknown as Record<string, unknown>).pinned = "yes"),
      "pinned",
    ],
    ["negative size", (i) => void (i.backups[0]!.size = -1), "size"],
    ["folder with slash", (i) => void (i.backups[0]!.folder = "a/b"), "single folder name"],
    ["diff without base", (i) => void i.backups.push({ ...entry("d", 3), type: "diff" }), "baseId"],
    ["full with base", (i) => void (i.backups[0]!.baseId = "zzz"), "baseId"],
  ];
  it.each(bad)("rejects %s", (_n, mutate, fragment) => {
    const idx = clone({ schemaVersion: 1, backups: [entry("a", 1)] } as BackupIndex);
    mutate(idx);
    expect(() => validateIndex(idx)).toThrow(ManifestError);
    expect(() => validateIndex(idx)).toThrow(fragment);
  });

  it("rejects non-objects, missing arrays and newer schema versions", () => {
    expect(() => validateIndex(null)).toThrow(ManifestError);
    expect(() => validateIndex({ schemaVersion: 1 })).toThrow("backups");
    expect(() => validateIndex({ schemaVersion: 2, backups: [] })).toThrow("newer Rewind Vault");
  });
});

describe("load and save", () => {
  it("a missing index loads as empty", async () => {
    expect(await loadIndex(new MockVaultStore(), "backup")).toEqual(emptyIndex());
  });

  it("save then load round-trips with no leftovers", async () => {
    const store = new MockVaultStore();
    const idx = addBackup(addBackup(emptyIndex(), entry("a", 1)), diff("b", 2, "a"));
    await saveIndex(store, "backup", idx);
    expect(await loadIndex(store, "backup")).toEqual(idx);
    expect((await store.list("backup")).files).toEqual([indexPath("backup")]);
  });

  it("a damaged index is an error, never silently reset", async () => {
    const store = new MockVaultStore();
    await store.seed("backup/index.json", "{ broken");
    await expect(loadIndex(store, "backup")).rejects.toThrow("not valid JSON");
  });

  it("recovers an index left behind by a crash between the atomic swap steps", async () => {
    const store = new MockVaultStore();
    await saveIndex(store, "backup", addBackup(emptyIndex(), entry("a", 1)));
    await store.rename("backup/index.json", "backup/index.json.bak"); // crash after step 2
    const loaded = await loadIndex(store, "backup");
    expect(loaded.backups.map((b) => b.id)).toEqual(["a"]);
  });

  it("refuses to save an invalid index", async () => {
    const store = new MockVaultStore();
    const bad = { schemaVersion: 1, backups: [entry("a", 1), entry("a", 2)] };
    await expect(saveIndex(store, "backup", bad)).rejects.toThrow(ManifestError);
    expect(await store.exists("backup/index.json")).toBe(false);
  });
});

describe("pure operations", () => {
  it("add, find, update and remove do not mutate their input", () => {
    const empty = emptyIndex();
    const one = addBackup(empty, entry("a", 1));
    expect(empty.backups).toHaveLength(0);
    expect(findBackup(one, "a")?.size).toBe(10);
    const pinned = updateBackup(one, "a", { pinned: true, label: "milestone" });
    expect(findBackup(one, "a")?.pinned).toBe(false);
    expect(findBackup(pinned, "a")).toMatchObject({ pinned: true, label: "milestone" });
    expect(removeBackup(pinned, "a").backups).toEqual([]);
    expect(removeBackup(pinned, "missing").backups).toHaveLength(1);
  });

  it("add rejects a duplicate id and update rejects an unknown id", () => {
    const idx = addBackup(emptyIndex(), entry("a", 1));
    expect(() => addBackup(idx, entry("a", 2))).toThrow("already registered");
    expect(() => updateBackup(idx, "zzz", { pinned: true })).toThrow("not registered");
  });

  it("sortedBackups is newest first with a stable tie-break", () => {
    const idx: BackupIndex = {
      schemaVersion: 1,
      backups: [entry("a", 1), entry("c", 3), entry("b", 3), entry("d", 2)],
    };
    expect(sortedBackups(idx).map((b) => b.id)).toEqual(["c", "b", "d", "a"]);
    expect(idx.backups.map((b) => b.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("entryFromManifest copies identity and starts unpinned", () => {
    const m = createManifest({
      id: "x_diff",
      type: "diff",
      baseId: "x_full",
      createdAt: 99,
      pluginVersion: "0.0.1",
      platform: "mobile",
      encryption: {
        enabled: false,
        kdf: "PBKDF2-SHA256",
        iterations: 600000,
        salt: "",
        algo: "AES-256-GCM",
      },
    });
    expect(entryFromManifest(m, "x_diff", 123)).toEqual({
      id: "x_diff",
      type: "diff",
      baseId: "x_full",
      createdAt: 99,
      status: "in-progress",
      pinned: false,
      size: 123,
      folder: "x_diff",
    });
  });
});

describe("chainFor", () => {
  const idx: BackupIndex = {
    schemaVersion: 1,
    backups: [
      entry("full1", 1),
      diff("d1", 2, "full1"),
      diff("d2", 3, "full1"),
      entry("full2", 4),
      diff("d3", 5, "full2"),
    ],
  };

  it("returns base plus diffs up to and including the target, oldest first", () => {
    expect(chainFor(idx, "d2")?.map((b) => b.id)).toEqual(["full1", "d1", "d2"]);
    expect(chainFor(idx, "d1")?.map((b) => b.id)).toEqual(["full1", "d1"]);
    expect(chainFor(idx, "d3")?.map((b) => b.id)).toEqual(["full2", "d3"]);
  });

  it("a full backup's chain is itself plus all its diffs up to it (just itself)", () => {
    expect(chainFor(idx, "full1")?.map((b) => b.id)).toEqual(["full1"]);
  });

  it("is null for unknown ids and for diffs whose base is gone", () => {
    expect(chainFor(idx, "nope")).toBeNull();
    expect(chainFor(removeBackup(idx, "full1"), "d2")).toBeNull();
  });
});
