import { describe, expect, it } from "vitest";
import { RestoreEngine } from "../../src/core/RestoreEngine";
import { RestoreError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, fastMaster, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

/**
 * Full: docs/a.md, docs/sub/b.md, docs/sub/deep/c.md, other/d.md, docsx/e.md.
 * Then a diff edits docs/a.md and adds docs/new.md.
 */
async function scenario(
  tweak?: Parameters<typeof rig>[0],
): Promise<{ r: Rig; fullId: string; diffId: string }> {
  const r = rig(tweak);
  for (const [p, t] of Object.entries({
    "docs/a.md": "a v1",
    "docs/sub/b.md": "b",
    "docs/sub/deep/c.md": "c",
    "other/d.md": "d",
    "docsx/e.md": "e",
  })) {
    await r.store.seed(p, t);
  }
  r.clock.advance(10 * SECOND);
  const { backupId: fullId } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10 * SECOND);
  await r.store.writeBinary("docs/a.md", enc("a v2"));
  await r.store.seed("docs/new.md", "new");
  const { backupId: diffId } = await runOk(r.engine, { mode: "diff" });
  return { r, fullId, diffId };
}

describe("restoreFolder", () => {
  it("restores only files under the folder, keeping relative paths, into the restore folder", async () => {
    const { r, diffId } = await scenario();
    const res = await restoreEngineFor(r).restoreFolder({
      source: { id: diffId },
      path: "docs",
      destination: { kind: "restore-folder" },
    });
    expect(res).toMatchObject({ created: 4, replaced: 0, unchanged: 0, deleted: 0 });
    const root = `restore/${diffId}`;
    expect(res.destinationRoot).toBe(root);
    expect(await readText(r.store, `${root}/docs/a.md`)).toBe("a v2");
    expect(await readText(r.store, `${root}/docs/sub/deep/c.md`)).toBe("c");
    expect(await readText(r.store, `${root}/docs/new.md`)).toBe("new");
    expect(await r.store.exists(`${root}/other/d.md`)).toBe(false);
    expect(await r.store.exists(`${root}/docsx/e.md`)).toBe(false); // prefix sibling is not inside
  });

  it("accepts a trailing slash and a nested folder", async () => {
    const { r, diffId } = await scenario();
    const res = await restoreEngineFor(r).restoreFolder({
      source: { id: diffId },
      path: "docs/sub/",
      destination: { kind: "restore-folder" },
    });
    expect(res.created).toBe(2);
  });

  it("restores the versions as of an older backup", async () => {
    const { r, fullId } = await scenario();
    const res = await restoreEngineFor(r).restoreFolder({
      source: { id: fullId },
      path: "docs",
      destination: { kind: "restore-folder" },
    });
    expect(res.created).toBe(3);
    expect(await readText(r.store, `restore/${fullId}/docs/a.md`)).toBe("a v1");
    expect(await r.store.exists(`restore/${fullId}/docs/new.md`)).toBe(false);
  });

  it("into the vault: creates missing files, leaves other files alone", async () => {
    const { r, diffId } = await scenario();
    await r.store.remove("docs/sub/b.md");
    await r.store.seed("docs/extra.md", "not in backup");
    const res = await restoreEngineFor(r).restoreFolder({
      source: { id: diffId },
      path: "docs",
      destination: { kind: "vault" },
    });
    expect(res).toMatchObject({ created: 1, unchanged: 3, replaced: 0 });
    expect(await readText(r.store, "docs/sub/b.md")).toBe("b");
    expect(await readText(r.store, "docs/extra.md")).toBe("not in backup");
  });

  it("is all-or-nothing on conflicts: without overwrite nothing is written", async () => {
    const { r, fullId } = await scenario();
    await r.store.remove("docs/sub/b.md"); // would be created
    const before = await r.store.list("");
    await expect(
      restoreEngineFor(r).restoreFolder({
        source: { id: fullId },
        path: "docs",
        destination: { kind: "vault" }, // docs/a.md differs (v2 live vs v1)
      }),
    ).rejects.toThrow(/overwrite was not chosen/);
    expect(await r.store.exists("docs/sub/b.md")).toBe(false);
    expect(await r.store.list("")).toEqual(before);
  });

  it("with overwrite replaces differing files", async () => {
    const { r, fullId } = await scenario();
    const res = await restoreEngineFor(r).restoreFolder({
      source: { id: fullId },
      path: "docs",
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(res).toMatchObject({ replaced: 1, created: 0, unchanged: 2 });
    expect(await readText(r.store, "docs/a.md")).toBe("a v1");
    expect(await readText(r.store, "docs/new.md")).toBe("new"); // not in that backup: untouched
  });

  it("running the same restore twice is a no-op the second time", async () => {
    const { r, diffId } = await scenario();
    const eng = restoreEngineFor(r);
    const req = {
      source: { id: diffId },
      path: "docs",
      destination: { kind: "restore-folder" },
    } as const;
    await eng.restoreFolder(req);
    const again = await eng.restoreFolder(req);
    expect(again).toMatchObject({ created: 0, replaced: 0, unchanged: 4, bytesWritten: 0 });
  });

  it("rejects a folder with no files, an unsafe path, and a file path", async () => {
    const { r, diffId } = await scenario();
    const eng = restoreEngineFor(r);
    for (const path of ["nonexistent", "../x", "/abs", "docs/a.md"]) {
      await expect(
        eng.restoreFolder({
          source: { id: diffId },
          path,
          destination: { kind: "restore-folder" },
        }),
      ).rejects.toThrow(RestoreError);
    }
  });

  it("handles many files across several parts", async () => {
    const r = rig((p) => void (p.zip.maxFilesPerZip = 3));
    for (let i = 0; i < 10; i++) await r.store.seed(`bulk/f${i}.md`, `file ${i}`);
    const { backupId } = await runOk(r.engine, { mode: "full" });
    const res = await restoreEngineFor(r).restoreFolder({
      source: { id: backupId },
      path: "bulk",
      destination: { kind: "restore-folder" },
    });
    expect(res.created).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(await readText(r.store, `restore/${backupId}/bulk/f${i}.md`)).toBe(`file ${i}`);
    }
  });

  it("decrypts encrypted backups; fails without a key and writes nothing", async () => {
    const { r, fullId } = await scenario((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    const req = {
      source: { id: fullId },
      path: "docs",
      destination: { kind: "restore-folder" },
    } as const;
    await expect(restoreEngineFor(r).restoreFolder(req)).rejects.toThrow(/passphrase/);
    expect(await r.store.exists(`restore/${fullId}/docs/a.md`)).toBe(false);
    const eng = new RestoreEngine({
      store: r.store,
      logger: r.logger,
      clock: r.clock,
      getProfile: () => r.profile,
      yieldIfNeeded: async () => undefined,
      deriveMasterKey: fastMaster,
    });
    expect((await eng.restoreFolder(req)).created).toBe(3);
    expect(await readText(r.store, `restore/${fullId}/docs/a.md`)).toBe("a v1");
  });
});
