import { describe, expect, it } from "vitest";
import { normaliseScope } from "../../src/core/RestoreTypes";
import { RestoreError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

/** Full: a.md, b.md, sub/c.md, sub/d.md. Then a diff edits a.md and adds new.md. */
async function scenario(): Promise<{ r: Rig; fullId: string; diffId: string }> {
  const r = rig();
  for (const [p, t] of Object.entries({
    "a.md": "a v1",
    "b.md": "b",
    "sub/c.md": "c",
    "sub/d.md": "d",
  })) {
    await r.store.seed(p, t);
  }
  r.clock.advance(10_000);
  const { backupId: fullId } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10_000);
  await r.store.writeBinary("a.md", enc("a v2"));
  await r.store.seed("new.md", "new");
  const { backupId: diffId } = await runOk(r.engine, { mode: "diff" });
  return { r, fullId, diffId };
}

describe("restoreFiles (selective restore)", () => {
  it("writes exactly the selected files, nothing else, into the restore folder", async () => {
    const { r, diffId } = await scenario();
    const res = await restoreEngineFor(r).restoreFiles({
      source: { id: diffId },
      paths: ["a.md", "sub/d.md"],
    });
    expect(res).toMatchObject({ created: 2, replaced: 0, deleted: 0 });
    const root = `restore/${diffId}`;
    expect(await readText(r.store, `${root}/a.md`)).toBe("a v2");
    expect(await readText(r.store, `${root}/sub/d.md`)).toBe("d");
    for (const other of ["b.md", "sub/c.md", "new.md"]) {
      expect(await r.store.exists(`${root}/${other}`), other).toBe(false);
    }
  });

  it("restores the version from the chosen backup (an older one has the old content)", async () => {
    const { r, fullId } = await scenario();
    await restoreEngineFor(r).restoreFiles({ source: { id: fullId }, paths: ["a.md"] });
    expect(await readText(r.store, `restore/${fullId}/a.md`)).toBe("a v1");
  });

  it("never touches the live vault when the destination is the restore folder", async () => {
    const { r, diffId } = await scenario();
    await r.store.writeBinary("a.md", enc("live edit"));
    await restoreEngineFor(r).restoreFiles({ source: { id: diffId }, paths: ["a.md"] });
    expect(await readText(r.store, "a.md")).toBe("live edit");
  });

  it("into the vault: replaces only with overwrite, and leaves unselected differing files alone", async () => {
    const { r, diffId } = await scenario();
    await r.store.writeBinary("a.md", enc("live a"));
    await r.store.writeBinary("b.md", enc("live b"));
    const engine = restoreEngineFor(r, {});
    await expect(
      engine.restoreFiles({
        source: { id: diffId },
        paths: ["a.md"],
        destination: { kind: "vault" },
      }),
    ).rejects.toThrow(RestoreError);
    expect(await readText(r.store, "a.md")).toBe("live a"); // nothing written

    const res = await engine.restoreFiles({
      source: { id: diffId },
      paths: ["a.md"],
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(res).toMatchObject({ replaced: 1, created: 0 });
    expect(await readText(r.store, "a.md")).toBe("a v2");
    expect(await readText(r.store, "b.md")).toBe("live b"); // not selected, not touched
  });

  it("vault restore takes the safety snapshot first, only because something will change", async () => {
    const { r, diffId } = await scenario();
    await r.store.writeBinary("a.md", enc("live a"));
    const res = await restoreEngineFor(r).restoreFiles({
      source: { id: diffId },
      paths: ["a.md"],
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(res.snapshot).toBeTruthy();
    expect(res.snapshot).not.toBe("up-to-date");
  });

  it("never deletes anything, even in the vault", async () => {
    const { r, diffId } = await scenario();
    await r.store.seed("extra.md", "not in the backup");
    await restoreEngineFor(r).restoreFiles({
      source: { id: diffId },
      paths: ["b.md"],
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(await r.store.exists("extra.md")).toBe(true);
  });

  it("a path that is not in the backup fails before anything is written", async () => {
    const { r, fullId } = await scenario();
    await expect(
      restoreEngineFor(r).restoreFiles({ source: { id: fullId }, paths: ["a.md", "new.md"] }),
    ).rejects.toThrow(/new\.md.*not in backup/);
    expect(await r.store.exists(`restore/${fullId}/a.md`)).toBe(false);
  });

  it("an empty selection and unsafe paths are rejected", async () => {
    const { r, diffId } = await scenario();
    const engine = restoreEngineFor(r);
    await expect(engine.restoreFiles({ source: { id: diffId }, paths: [] })).rejects.toThrow(
      /No files were selected/,
    );
    for (const bad of ["../x.md", "/abs.md", "a//b.md", "a\\b.md"]) {
      await expect(
        engine.restoreFiles({ source: { id: diffId }, paths: [bad] }),
        bad,
      ).rejects.toThrow(RestoreError);
    }
  });

  it("duplicates in the selection are harmless", async () => {
    const { r, diffId } = await scenario();
    const res = await engine(r).restoreFiles({
      source: { id: diffId },
      paths: ["b.md", "b.md", "b.md"],
    });
    expect(res.created).toBe(1);
  });

  it("re-running is idempotent for identical files", async () => {
    const { r, diffId } = await scenario();
    const e = engine(r);
    await e.restoreFiles({ source: { id: diffId }, paths: ["b.md"] });
    const again = await e.restoreFiles({ source: { id: diffId }, paths: ["b.md"] });
    expect(again).toMatchObject({ created: 0, replaced: 0, unchanged: 1 });
  });

  it("reports progress and honours cancel like the other restores", async () => {
    const { r, diffId } = await scenario();
    const phases: string[] = [];
    await engine(r).restoreFiles(
      { source: { id: diffId }, paths: ["a.md", "b.md"] },
      { onProgress: (p) => phases.push(p.phase) },
    );
    expect(phases).toContain("writing");
    await expect(
      engine(r).restoreFiles(
        { source: { id: diffId }, paths: ["sub/c.md"] },
        { isCancelled: () => true },
      ),
    ).rejects.toThrow();
    expect(await r.store.exists(`restore/${diffId}/sub/c.md`)).toBe(false);
  });
});

const engine = restoreEngineFor;

describe("normaliseScope for files", () => {
  it("sorts and de-duplicates", () => {
    expect(normaliseScope({ kind: "files", paths: ["b", "a", "b"] })).toEqual({
      kind: "files",
      paths: ["a", "b"],
    });
  });
});

describe("large selections", () => {
  it("a 20,000-path scope is looked up in constant time per file", async () => {
    const { inScope } = await import("../../src/core/RestoreTypes");
    const paths = Array.from({ length: 20_000 }, (_, i) => `notes/n${i}.md`);
    const scope = normaliseScope({ kind: "files", paths });
    const started = Date.now();
    let hits = 0;
    for (const p of paths) if (inScope(scope, p)) hits++;
    expect(hits).toBe(20_000);
    expect(inScope(scope, "notes/other.md")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
