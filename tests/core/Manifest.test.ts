import { describe, expect, it } from "vitest";
import {
  createManifest,
  loadManifest,
  manifestPath,
  parseManifest,
  saveManifest,
  serializeManifest,
  validateManifest,
} from "../../src/core/Manifest";
import { ManifestError } from "../../src/helpers/errors";
import type { Manifest } from "../../src/types";
import { MockVaultStore } from "../mocks/MockVaultStore";

const H = (c: string): string => c.repeat(64);

function full(): Manifest {
  return {
    schemaVersion: 1,
    id: "2026-10-07T21-24-00_full",
    type: "full",
    baseId: null,
    createdAt: 1_790_000_000_000,
    pluginVersion: "0.0.1",
    platform: "desktop",
    encryption: {
      enabled: false,
      kdf: "PBKDF2-SHA256",
      iterations: 600_000,
      salt: "",
      algo: "AES-256-GCM",
    },
    parts: [
      { name: "part-001.zip", size: 100, sha256: H("a"), entryCount: 2 },
      { name: "part-002.zip", size: 50, sha256: H("b"), entryCount: 1 },
    ],
    entries: [
      { path: "a.md", size: 1, mtime: 10.5, sha256: H("1"), part: "part-001.zip", action: "add" },
      { path: "dir/b.md", size: 2, mtime: 11, sha256: H("2"), part: "part-001.zip", action: "add" },
      { path: "c.md", size: 3, mtime: 12, sha256: H("3"), part: "part-002.zip", action: "add" },
    ],
    tombstones: [],
    status: "ok",
  };
}

function diff(): Manifest {
  const m = full();
  m.id = "2026-10-08T09-00-00_diff";
  m.type = "diff";
  m.baseId = "2026-10-07T21-24-00_full";
  m.entries[0]!.action = "change";
  m.tombstones = [{ path: "gone.md", deletedAt: 1_790_000_100_000 }];
  return m;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("validateManifest accepts good manifests", () => {
  it("full, diff, with verify, hmac and encryption", () => {
    expect(validateManifest(clone(full()))).toEqual(full());
    expect(validateManifest(clone(diff()))).toEqual(diff());
    const m = full();
    m.verify = { lastLevel: 3, lastAt: 5, result: "pass" };
    m.hmac = "c2ln";
    m.encryption = { ...m.encryption, enabled: true, salt: "c2FsdA==" };
    expect(validateManifest(clone(m))).toEqual(m);
  });

  it("drops unknown fields", () => {
    const raw = { ...clone(full()), futureField: 1 };
    expect(validateManifest(raw)).not.toHaveProperty("futureField");
  });

  it("createManifest produces a valid empty in-progress manifest", () => {
    const m = createManifest({
      id: "x_full",
      type: "full",
      baseId: null,
      createdAt: 1,
      pluginVersion: "0.0.1",
      platform: "mobile",
      encryption: full().encryption,
    });
    expect(m.status).toBe("in-progress");
    expect(validateManifest(clone(m))).toEqual(m);
  });
});

describe("validateManifest rejects bad manifests", () => {
  const cases: [string, (m: Manifest) => void, string][] = [
    ["missing id", (m) => void ((m as unknown as Record<string, unknown>).id = ""), "manifest.id"],
    [
      "bad type",
      (m) => void ((m as unknown as Record<string, string>).type = "weird"),
      "manifest.type",
    ],
    ["full with baseId", (m) => void (m.baseId = "x"), "baseId"],
    [
      "bad platform",
      (m) => void ((m as unknown as Record<string, string>).platform = "tv"),
      "platform",
    ],
    [
      "bad status",
      (m) => void ((m as unknown as Record<string, string>).status = "done"),
      "status",
    ],
    ["negative createdAt", (m) => void (m.createdAt = -1), "createdAt"],
    ["entry hash not hex", (m) => void (m.entries[0]!.sha256 = "xyz"), "entries[0].sha256"],
    ["entry hash uppercase", (m) => void (m.entries[0]!.sha256 = H("A")), "entries[0].sha256"],
    ["entry size fraction", (m) => void (m.entries[0]!.size = 1.5), "entries[0].size"],
    ["unknown part", (m) => void (m.entries[0]!.part = "part-009.zip"), "unknown part"],
    ["duplicate entry path", (m) => void (m.entries[1]!.path = "a.md"), "duplicates entry"],
    ["change in full", (m) => void (m.entries[0]!.action = "change"), "full backup"],
    ["part count mismatch", (m) => void (m.parts[0]!.entryCount = 5), "entryCount"],
    ["duplicate part", (m) => void (m.parts[1]!.name = "part-001.zip"), "duplicates part"],
    ["tombstone in full", (m) => void m.tombstones.push({ path: "x", deletedAt: 1 }), "tombstones"],
    [
      "weak kdf when enabled",
      (m) => void (m.encryption = { ...m.encryption, enabled: true, salt: "s", iterations: 1000 }),
      "iterations",
    ],
    [
      "enabled without salt",
      (m) => void (m.encryption = { ...m.encryption, enabled: true, salt: "" }),
      "salt",
    ],
    [
      "verify level 9",
      (m) => void (m.verify = { lastLevel: 9 as 1, lastAt: 1, result: "pass" }),
      "lastLevel",
    ],
  ];
  it.each(cases)("%s", (_n, mutate, fragment) => {
    const m = clone(full());
    mutate(m);
    expect(() => validateManifest(m)).toThrow(ManifestError);
    expect(() => validateManifest(m)).toThrow(fragment);
  });

  const diffCases: [string, (m: Manifest) => void, string][] = [
    ["diff without baseId", (m) => void (m.baseId = null), "baseId"],
    [
      "tombstone duplicates",
      (m) => void m.tombstones.push({ path: "gone.md", deletedAt: 2 }),
      "duplicates tombstone",
    ],
    [
      "path both stored and deleted",
      (m) => void (m.tombstones[0]!.path = "a.md"),
      "both stored and deleted",
    ],
  ];
  it.each(diffCases)("%s", (_n, mutate, fragment) => {
    const m = clone(diff());
    mutate(m);
    expect(() => validateManifest(m)).toThrow(fragment);
  });

  it.each(["../escape.md", "/abs.md", "a/../b.md", "a\\b.md", "a//b.md", "a/", "nul\0.md"])(
    "rejects unsafe entry path %j",
    (path) => {
      const m = clone(full());
      m.entries[0]!.path = path;
      expect(() => validateManifest(m)).toThrow("safe relative path");
    },
  );

  it("rejects unsafe tombstone paths", () => {
    const m = clone(diff());
    m.tombstones[0]!.path = "../x";
    expect(() => validateManifest(m)).toThrow("safe relative path");
  });

  it.each([null, 5, "str", [], undefined])("rejects non-object input %j", (raw) => {
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it("rejects missing arrays", () => {
    const m = clone(full()) as unknown as Record<string, unknown>;
    delete m.entries;
    expect(() => validateManifest(m)).toThrow("entries");
  });
});

describe("schema version", () => {
  it("rejects a newer version with an upgrade message", () => {
    const m = { ...clone(full()), schemaVersion: 2 };
    expect(() => validateManifest(m)).toThrow("newer Rewind Vault");
  });

  it.each([0, -1, 1.5, "1", undefined])("rejects invalid schemaVersion %j", (v) => {
    expect(() => validateManifest({ ...clone(full()), schemaVersion: v })).toThrow("schemaVersion");
  });
});

describe("parse, load and save", () => {
  it("parseManifest round-trips serializeManifest", () => {
    expect(parseManifest(serializeManifest(diff()))).toEqual(diff());
  });

  it("parseManifest reports invalid JSON as ManifestError", () => {
    expect(() => parseManifest("{not json")).toThrow(ManifestError);
  });

  it("save then load returns the same manifest, with no temp files left", async () => {
    const store = new MockVaultStore();
    await saveManifest(store, "backup/2026_full", full());
    expect(await loadManifest(store, "backup/2026_full")).toEqual(full());
    expect((await store.list("backup/2026_full")).files).toEqual([
      manifestPath("backup/2026_full"),
    ]);
  });

  it("save replaces an existing manifest", async () => {
    const store = new MockVaultStore();
    await saveManifest(store, "b/x", full());
    const updated = full();
    updated.status = "corrupt";
    await saveManifest(store, "b/x", updated);
    expect((await loadManifest(store, "b/x")).status).toBe("corrupt");
  });

  it("save refuses an invalid manifest and writes nothing", async () => {
    const store = new MockVaultStore();
    const bad = clone(full());
    bad.entries[0]!.sha256 = "nope";
    await expect(saveManifest(store, "b/x", bad)).rejects.toThrow(ManifestError);
    expect(await store.exists(manifestPath("b/x"))).toBe(false);
  });

  it("load wraps a missing file and a corrupt file in ManifestError", async () => {
    const store = new MockVaultStore();
    await expect(loadManifest(store, "b/missing")).rejects.toThrow(ManifestError);
    await store.seed("b/bad/manifest.json", "{ truncated");
    await expect(loadManifest(store, "b/bad")).rejects.toThrow("not valid JSON");
  });
});
