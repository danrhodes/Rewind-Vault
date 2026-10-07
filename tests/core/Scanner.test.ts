import { describe, expect, it } from "vitest";
import {
  createExcludeCheck,
  scanOptionsFromProfile,
  scanVault,
  type ScanOptions,
} from "../../src/core/Scanner";
import { createDefaultProfile } from "../../src/settings/defaults";
import { MockClock } from "../mocks/MockClock";
import { MockVaultStore } from "../mocks/MockVaultStore";

const base: ScanOptions = {
  backupFolder: "backup",
  includeHidden: true,
  excludeHidden: false,
  excludeObsidian: false,
  excludeGit: true,
  excludeNodeModules: true,
  excludeTrash: true,
  globs: [],
};

async function vault(files: Record<string, string>): Promise<MockVaultStore> {
  const store = new MockVaultStore(new MockClock(5000));
  for (const [path, text] of Object.entries(files)) await store.seed(path, text);
  return store;
}

const paths = async (store: MockVaultStore, opts: ScanOptions): Promise<string[]> =>
  (await scanVault(store, opts, async () => undefined)).map((f) => f.path);

describe("scanVault", () => {
  it("returns files with size and mtime, sorted, across nested folders", async () => {
    const store = await vault({ "b.md": "bb", "a/z.md": "z", "a/y/deep.md": "deep", "a.md": "a" });
    const files = await scanVault(store, base, async () => undefined);
    expect(files.map((f) => f.path)).toEqual(["a.md", "a/y/deep.md", "a/z.md", "b.md"]);
    expect(files[3]).toEqual({ path: "b.md", size: 2, mtime: 5000 });
  });

  it("always excludes the backup folder, even with everything else included", async () => {
    const store = await vault({
      "note.md": "x",
      "backup/index.json": "{}",
      "backup/2026_full/part-001.zip": "zip",
    });
    expect(await paths(store, base)).toEqual(["note.md"]);
    expect(await paths(store, { ...base, excludeGit: false, includeHidden: true })).toEqual([
      "note.md",
    ]);
  });

  it("honours a nested or renamed backup folder", async () => {
    const store = await vault({
      "note.md": "x",
      "tools/bk/index.json": "{}",
      "backup/a.md": "kept",
    });
    expect(await paths(store, { ...base, backupFolder: "tools/bk" })).toEqual([
      "backup/a.md",
      "note.md",
    ]);
  });

  it("does not confuse a similarly named folder with the backup folder", async () => {
    const store = await vault({ "backup2/a.md": "x", "my-backup/b.md": "y" });
    expect(await paths(store, base)).toEqual(["backup2/a.md", "my-backup/b.md"]);
  });

  it("hidden toggle: includeHidden=false drops every hidden path", async () => {
    const store = await vault({
      "a.md": "x",
      ".obsidian/app.json": "{}",
      "notes/.secret/b.md": "x",
      "notes/.env": "x",
    });
    expect(await paths(store, { ...base, includeHidden: false })).toEqual(["a.md"]);
    expect(await paths(store, base)).toEqual([
      ".obsidian/app.json",
      "a.md",
      "notes/.env",
      "notes/.secret/b.md",
    ]);
  });

  it("excludeHidden overrides includeHidden", async () => {
    const store = await vault({ "a.md": "x", ".obsidian/app.json": "{}" });
    expect(await paths(store, { ...base, includeHidden: true, excludeHidden: true })).toEqual([
      "a.md",
    ]);
  });

  it(".obsidian is kept by default but can be excluded on its own", async () => {
    const store = await vault({ "a.md": "x", ".obsidian/app.json": "{}", "x/.obsidian/y": "k" });
    expect(await paths(store, { ...base, excludeObsidian: true })).toEqual([
      "a.md",
      "x/.obsidian/y",
    ]);
  });

  it("excludes .trash, .git (at any depth) and node_modules (at any depth) by toggle", async () => {
    const store = await vault({
      "a.md": "x",
      ".trash/old.md": "x",
      ".git/config": "x",
      "sub/.git/HEAD": "x",
      "node_modules/pkg/index.js": "x",
      "web/node_modules/pkg/i.js": "x",
    });
    expect(await paths(store, base)).toEqual(["a.md"]);
    expect(
      await paths(store, {
        ...base,
        excludeGit: false,
        excludeTrash: false,
        excludeNodeModules: false,
      }),
    ).toHaveLength(6);
  });

  it("applies user globs including negation", async () => {
    const store = await vault({
      "a.md": "x",
      "x.tmp": "x",
      "deep/y.tmp": "x",
      "drafts/one.md": "x",
      "archive/old.md": "x",
      "archive/keep.md": "x",
    });
    expect(
      await paths(store, {
        ...base,
        globs: ["*.tmp", "drafts/", "archive/**", "!archive/keep.md"],
      }),
    ).toEqual(["a.md", "archive/keep.md"]);
  });

  it("does not list excluded folders at all", async () => {
    const store = await vault({ "a.md": "x", "node_modules/p/i.js": "x", "backup/i.json": "x" });
    const listed: string[] = [];
    const original = store.list.bind(store);
    store.list = async (p: string) => {
      listed.push(p);
      return original(p);
    };
    await paths(store, base);
    expect(listed).toEqual([""]);
  });

  it("yields to the UI between folders", async () => {
    const store = await vault({ "a/1.md": "x", "b/2.md": "x", "c/3.md": "x" });
    let yields = 0;
    await scanVault(store, base, async () => void yields++);
    expect(yields).toBe(4); // root + 3 folders
  });

  it("handles an empty vault and an empty backup-folder setting", async () => {
    expect(await paths(await vault({}), base)).toEqual([]);
    const store = await vault({ "backup/a.md": "x" });
    expect(await paths(store, { ...base, backupFolder: "" })).toEqual(["backup/a.md"]);
  });
});

describe("createExcludeCheck and profile mapping", () => {
  it("maps a settings profile onto scan options", () => {
    const p = createDefaultProfile("desktop");
    p.destination.backupFolder = "bk";
    p.exclusions.globs = ["*.log"];
    const opts = scanOptionsFromProfile(p);
    expect(opts).toMatchObject({ backupFolder: "bk", globs: ["*.log"], excludeGit: true });
    const check = createExcludeCheck(opts);
    expect(check("bk/index.json")).toBe(true);
    expect(check("debug.log")).toBe(true);
    expect(check("notes/a.md")).toBe(false);
  });
});
