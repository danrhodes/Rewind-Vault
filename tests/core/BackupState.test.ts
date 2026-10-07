import { describe, expect, it } from "vitest";
import { loadState, saveState, statePath, validateState } from "../../src/core/BackupState";
import { ManifestError } from "../../src/helpers/errors";
import type { BackupState } from "../../src/types";
import { MockVaultStore } from "../mocks/MockVaultStore";

const H = (c: string): string => c.repeat(64);
const good = (): BackupState => ({
  schemaVersion: 1,
  updatedAt: 1_790_000_000_000,
  files: {
    "a.md": { mtime: 10.5, size: 3, sha256: H("a") },
    "dir/b.md": { mtime: 20, size: 0, sha256: H("b") },
  },
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("validateState", () => {
  it("accepts a good state, including an empty one", () => {
    expect(validateState(clone(good()))).toEqual(good());
    expect(validateState({ schemaVersion: 1, updatedAt: 0, files: {} }).files).toEqual({});
  });

  const bad: [string, (s: BackupState) => void, string][] = [
    ["bad hash", (s) => void (s.files["a.md"]!.sha256 = "zz"), "sha256"],
    ["negative size", (s) => void (s.files["a.md"]!.size = -1), "size"],
    ["fractional size", (s) => void (s.files["a.md"]!.size = 1.5), "size"],
    [
      "non-number mtime",
      (s) => void ((s.files["a.md"] as unknown as Record<string, unknown>).mtime = "x"),
      "mtime",
    ],
    [
      "unsafe path",
      (s) => void (s.files["../evil"] = { mtime: 1, size: 1, sha256: H("c") }),
      "safe relative path",
    ],
    [
      "absolute path",
      (s) => void (s.files["/abs"] = { mtime: 1, size: 1, sha256: H("c") }),
      "safe relative path",
    ],
  ];
  it.each(bad)("rejects %s", (_n, mutate, fragment) => {
    const s = clone(good());
    mutate(s);
    expect(() => validateState(s)).toThrow(ManifestError);
    expect(() => validateState(s)).toThrow(fragment);
  });

  it("rejects non-objects, a missing files map and newer versions", () => {
    expect(() => validateState("x")).toThrow(ManifestError);
    expect(() => validateState({ schemaVersion: 1, updatedAt: 0 })).toThrow("files");
    expect(() => validateState({ schemaVersion: 2, updatedAt: 0, files: {} })).toThrow("newer");
  });
});

describe("load and save", () => {
  it("missing state loads as empty (meaning: no history yet)", async () => {
    const s = await loadState(new MockVaultStore(), "backup");
    expect(s.files).toEqual({});
    expect(s.updatedAt).toBe(0);
  });

  it("round-trips and leaves no temp files", async () => {
    const store = new MockVaultStore();
    await saveState(store, "backup", good());
    expect(await loadState(store, "backup")).toEqual(good());
    expect((await store.list("backup")).files).toEqual([statePath("backup")]);
  });

  it("handles a 10,000-file state", async () => {
    const store = new MockVaultStore();
    const state: BackupState = { schemaVersion: 1, updatedAt: 1, files: {} };
    for (let i = 0; i < 10_000; i++) {
      state.files[`folder${i % 50}/note-${i}.md`] = { mtime: i, size: i, sha256: H("d") };
    }
    await saveState(store, "backup", state);
    const loaded = await loadState(store, "backup");
    expect(Object.keys(loaded.files)).toHaveLength(10_000);
  });

  it("a damaged state file is an error, not silently empty", async () => {
    const store = new MockVaultStore();
    await store.seed("backup/state.json", "{ nope");
    await expect(loadState(store, "backup")).rejects.toThrow("not valid JSON");
  });

  it("recovers from a crash between the atomic swap steps", async () => {
    const store = new MockVaultStore();
    await saveState(store, "backup", good());
    await store.rename("backup/state.json", "backup/state.json.bak");
    expect(await loadState(store, "backup")).toEqual(good());
  });

  it("refuses to save an invalid state", async () => {
    const store = new MockVaultStore();
    const bad = clone(good());
    bad.files["a.md"]!.sha256 = "nope";
    await expect(saveState(store, "backup", bad)).rejects.toThrow(ManifestError);
    expect(await store.exists("backup/state.json")).toBe(false);
  });
});
