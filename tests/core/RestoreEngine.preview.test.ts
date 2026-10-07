import { describe, expect, it } from "vitest";
import { RestoreError, BrokenChainError } from "../../src/helpers/errors";
import { enc, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

/**
 * Vault at backup time: a.md, b.md, docs/c.md, docs/d.md, docs/deep/e.md, img/f.png.
 * After the backup: b.md edited, a.md deleted, new.md and docs/new.md added,
 * docs/c.md touched with identical bytes.
 */
async function scenario(): Promise<{ r: Rig; backupId: string; at: number }> {
  const r = rig();
  for (const [p, t] of Object.entries({
    "a.md": "alpha",
    "b.md": "bravo",
    "docs/c.md": "charlie",
    "docs/d.md": "delta",
    "docs/deep/e.md": "echo",
    "img/f.png": "foxtrot",
  })) {
    await r.store.seed(p, t);
  }
  r.clock.advance(10 * SECOND);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  const at = r.clock.now();

  r.clock.advance(10 * SECOND);
  await r.store.writeBinary("b.md", enc("bravo EDITED"));
  await r.store.remove("a.md");
  await r.store.seed("new.md", "new");
  await r.store.seed("docs/new.md", "new in docs");
  await r.store.writeBinary("docs/c.md", enc("charlie")); // same bytes, newer mtime
  return { r, backupId, at };
}

const paths = (items: { path: string }[]): string[] => items.map((i) => i.path);

describe("preview: restore folder (the default destination)", () => {
  it("puts everything under <restoreFolder>/<backup id>/ and adds it all", async () => {
    const { r, backupId } = await scenario();
    const p = await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "all" },
      destination: { kind: "restore-folder" },
    });
    expect(p.destinationRoot).toBe(`restore/${backupId}`);
    expect(paths(p.additions)).toEqual([
      "a.md",
      "b.md",
      "docs/c.md",
      "docs/d.md",
      "docs/deep/e.md",
      "img/f.png",
    ]);
    expect(p.changes).toEqual([]);
    expect(p.deletions).toEqual([]);
    expect(p.unchanged).toBe(0);
    expect(p.bytesToWrite).toBe(
      ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].join("").length,
    );
    expect(p.source.id).toBe(backupId);
    expect(p.additions[0]).toMatchObject({ path: "a.md", size: 5, backupId });
  });

  it("recognises files already restored there as unchanged, and edited ones as changes", async () => {
    const { r, backupId } = await scenario();
    const root = `restore/${backupId}`;
    await r.store.seed(`${root}/a.md`, "alpha"); // identical
    await r.store.seed(`${root}/b.md`, "BRAVO"); // same size, different bytes
    await r.store.seed(`${root}/docs/c.md`, "much longer than before"); // different size
    const p = await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "all" },
      destination: { kind: "restore-folder" },
    });
    expect(p.unchanged).toBe(1);
    expect(paths(p.changes)).toEqual(["b.md", "docs/c.md"]);
    expect(p.changes[0]).toMatchObject({ size: 5, currentSize: 5 });
    expect(p.changes[1]).toMatchObject({ size: 7, currentSize: 23 });
    expect(paths(p.additions)).toEqual(["docs/d.md", "docs/deep/e.md", "img/f.png"]);
  });

  it("respects a custom restore folder name", async () => {
    const { r, backupId } = await scenario();
    r.profile.destination.restoreFolder = "Recovered/Files";
    const p = await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "all" },
      destination: { kind: "restore-folder" },
    });
    expect(p.destinationRoot).toBe(`Recovered/Files/${backupId}`);
  });
});

describe("preview: into the vault", () => {
  const request = (backupId: string, extra: object = {}) => ({
    source: { id: backupId },
    scope: { kind: "all" as const },
    destination: { kind: "vault" as const },
    ...extra,
  });

  it("splits into additions (deleted since), changes (edited since) and unchanged", async () => {
    const { r, backupId } = await scenario();
    const p = await restoreEngineFor(r).preview(request(backupId));
    expect(p.destinationRoot).toBe("");
    expect(paths(p.additions)).toEqual(["a.md"]);
    expect(paths(p.changes)).toEqual(["b.md"]);
    expect(p.changes[0]).toMatchObject({ size: 5, currentSize: 12 });
    expect(p.unchanged).toBe(4); // c (touched only), d, e, f
    expect(p.bytesToWrite).toBe("alpha".length + "bravo".length);
    expect(p.deletions).toEqual([]); // not requested
  });

  it("lists files added after the backup as deletions only when asked, ignoring excluded paths", async () => {
    const { r, backupId } = await scenario();
    await r.store.seed(".hidden/secret.md", "x"); // hidden: excluded from backups, so not "extra"
    r.profile.basic.includeHidden = false;
    const p = await restoreEngineFor(r).preview(request(backupId, { deleteExtraneous: true }));
    expect(p.deletions).toEqual(["docs/new.md", "new.md"]);
    expect(p.deletions.some((d) => d.startsWith("backup/"))).toBe(false);
  });

  it("deleteExtraneous is ignored for the restore-folder destination and for single files", async () => {
    const { r, backupId } = await scenario();
    const e = restoreEngineFor(r);
    const toFolder = await e.preview({
      source: { id: backupId },
      scope: { kind: "all" },
      destination: { kind: "restore-folder" },
      deleteExtraneous: true,
    });
    expect(toFolder.deletions).toEqual([]);
    const single = await e.preview(
      request(backupId, { scope: { kind: "file", path: "b.md" }, deleteExtraneous: true }),
    );
    expect(single.deletions).toEqual([]);
  });
});

describe("preview: scope", () => {
  it("a single file", async () => {
    const { r, backupId } = await scenario();
    const p = await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "file", path: "docs/deep/e.md" },
      destination: { kind: "vault" },
    });
    expect(p.additions).toEqual([]);
    expect(p.unchanged).toBe(1);
    expect(p.bytesToWrite).toBe(0);
  });

  it("a folder includes its subfolders but nothing else", async () => {
    const { r, backupId } = await scenario();
    const e = restoreEngineFor(r);
    for (const path of ["docs", "docs/"]) {
      const p = await e.preview({
        source: { id: backupId },
        scope: { kind: "folder", path },
        destination: { kind: "restore-folder" },
      });
      expect(paths(p.additions)).toEqual(["docs/c.md", "docs/d.md", "docs/deep/e.md"]);
    }
  });

  it("folder deletions only cover that folder", async () => {
    const { r, backupId } = await scenario();
    const p = await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "folder", path: "docs" },
      destination: { kind: "vault" },
      deleteExtraneous: true,
    });
    expect(p.deletions).toEqual(["docs/new.md"]);
  });

  it("a file that is not in the backup is a RestoreError", async () => {
    const { r, backupId } = await scenario();
    await expect(
      restoreEngineFor(r).preview({
        source: { id: backupId },
        scope: { kind: "file", path: "new.md" },
        destination: { kind: "vault" },
      }),
    ).rejects.toBeInstanceOf(RestoreError);
  });

  it("an empty folder scope previews nothing; unsafe scopes are rejected", async () => {
    const { r, backupId } = await scenario();
    const e = restoreEngineFor(r);
    const empty = await e.preview({
      source: { id: backupId },
      scope: { kind: "folder", path: "nonexistent" },
      destination: { kind: "vault" },
    });
    expect(empty.additions.length + empty.changes.length + empty.unchanged).toBe(0);
    for (const path of ["../outside", "/abs", "a//b", ""]) {
      await expect(
        e.preview({
          source: { id: backupId },
          scope: { kind: "file", path },
          destination: { kind: "vault" },
        }),
      ).rejects.toBeInstanceOf(RestoreError);
    }
  });
});

describe("preview: sources and safety", () => {
  it("previews a point in time", async () => {
    const { r, at } = await scenario();
    const p = await restoreEngineFor(r).preview({
      source: { at: at + 3 * SECOND },
      scope: { kind: "all" },
      destination: { kind: "vault" },
    });
    expect(paths(p.additions)).toEqual(["a.md"]);
  });

  it("works across a chain: diff target shows its own tombstones and edits", async () => {
    const { r } = await scenario();
    r.clock.advance(SECOND);
    const diff = await runOk(r.engine, { mode: "diff" });
    const p = await restoreEngineFor(r).preview({
      source: { id: diff.backupId },
      scope: { kind: "all" },
      destination: { kind: "vault" },
    });
    expect(p.additions).toEqual([]);
    expect(p.changes).toEqual([]);
    expect(p.unchanged).toBe(7); // b, c, d, e, f, new, docs/new
    expect(p.source.type).toBe("diff");
  });

  it("changes nothing: no writes, removes or renames", async () => {
    const { r, backupId } = await scenario();
    const calls: string[] = [];
    for (const k of ["writeBinary", "remove", "removeFolder", "rename", "mkdir"] as const) {
      const original = (r.store[k] as (...a: unknown[]) => Promise<void>).bind(r.store);
      (r.store as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => (
        calls.push(k),
        original(...a)
      );
    }
    await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "all" },
      destination: { kind: "vault" },
      deleteExtraneous: true,
    });
    expect(calls).toEqual([]);
  });

  it("fails before any restore if a needed part file is missing", async () => {
    const { r, backupId } = await scenario();
    await r.store.remove(`backup/${backupId}/part-001.zip`);
    await expect(
      restoreEngineFor(r).preview({
        source: { id: backupId },
        scope: { kind: "all" },
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toBeInstanceOf(BrokenChainError);
  });

  it("a missing part that the chosen scope does not need is not an error", async () => {
    const r = rig((p) => void (p.zip.maxFilesPerZip = 1));
    await r.store.seed("a.md", "a");
    await r.store.seed("b.md", "b");
    const { backupId } = await runOk(r.engine, { mode: "full" });
    await r.store.remove(`backup/${backupId}/part-002.zip`);
    const p = await restoreEngineFor(r).preview({
      source: { id: backupId },
      scope: { kind: "file", path: "a.md" },
      destination: { kind: "vault" },
    });
    expect(p.unchanged).toBe(1);
  });
});
