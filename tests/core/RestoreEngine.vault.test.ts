import { describe, expect, it } from "vitest";
import { RestoreError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, restoreEngineFor, rig, runOk, seedVault, type Rig } from "../support/engineRig";

const SECOND = 1000;

/** Backup holds a.md, docs/b.md, docs/c.md. Afterwards: a.md edited, docs/b.md deleted, new.md added. */
async function scenario(): Promise<{ r: Rig; id: string }> {
  const r = rig();
  await r.store.seed("a.md", "alpha");
  await r.store.seed("docs/b.md", "bravo");
  await r.store.seed("docs/c.md", "charlie");
  r.clock.advance(10 * SECOND);
  const { backupId: id } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10 * SECOND);
  await r.store.writeBinary("a.md", enc("alpha EDITED"));
  await r.store.remove("docs/b.md");
  await r.store.seed("new.md", "new");
  return { r, id };
}

describe("restoreVault", () => {
  it("defaults to the restore folder and leaves the live vault untouched", async () => {
    const { r, id } = await scenario();
    const live = await r.store.list("");
    const res = await restoreEngineFor(r).restoreVault({ source: { id } });
    expect(res).toMatchObject({ destinationRoot: `restore/${id}`, created: 3, replaced: 0 });
    expect(await readText(r.store, `restore/${id}/a.md`)).toBe("alpha");
    expect(await readText(r.store, `restore/${id}/docs/b.md`)).toBe("bravo");
    expect(await readText(r.store, "a.md")).toBe("alpha EDITED");
    expect((await r.store.list("")).files).toEqual(live.files);
  });

  it("does not overwrite by default: a differing file aborts the whole restore", async () => {
    const { r, id } = await scenario();
    await expect(
      restoreEngineFor(r).restoreVault({ source: { id }, destination: { kind: "vault" } }),
    ).rejects.toThrow(/overwrite was not chosen/);
    expect(await readText(r.store, "a.md")).toBe("alpha EDITED");
    expect(await r.store.exists("docs/b.md")).toBe(false); // the missing file was not created either
  });

  it("with overwrite, brings the vault back; extra files are kept by default", async () => {
    const { r, id } = await scenario();
    const res = await restoreEngineFor(r).restoreVault({
      source: { id },
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(res).toMatchObject({ created: 1, replaced: 1, unchanged: 1, deleted: 0 });
    expect(await readText(r.store, "a.md")).toBe("alpha");
    expect(await readText(r.store, "docs/b.md")).toBe("bravo");
    expect(await readText(r.store, "new.md")).toBe("new");
  });

  it("with deleteExtraneous, makes the vault match the backup exactly", async () => {
    const { r, id } = await scenario();
    const res = await restoreEngineFor(r).restoreVault({
      source: { id },
      destination: { kind: "vault" },
      overwrite: true,
      deleteExtraneous: true,
    });
    expect(res.deleted).toBe(1);
    expect(await r.store.exists("new.md")).toBe(false);
    expect(await readText(r.store, "a.md")).toBe("alpha");
  });

  it("never deletes the backup folder or excluded paths", async () => {
    const { r, id } = await scenario();
    await r.store.seed(".git/config", "x");
    await restoreEngineFor(r).restoreVault({
      source: { id },
      destination: { kind: "vault" },
      overwrite: true,
      deleteExtraneous: true,
    });
    expect(await r.store.exists(`backup/${id}/manifest.json`)).toBe(true);
    expect(await r.store.exists("backup/index.json")).toBe(true);
    expect(await r.store.exists(".git/config")).toBe(true);
  });

  it("deleteExtraneous without overwrite, or into the restore folder, is refused", async () => {
    const { r, id } = await scenario();
    const eng = restoreEngineFor(r);
    await expect(
      eng.restoreVault({ source: { id }, destination: { kind: "vault" }, deleteExtraneous: true }),
    ).rejects.toThrow(RestoreError);
    await expect(
      eng.restoreVault({ source: { id }, overwrite: true, deleteExtraneous: true }),
    ).rejects.toThrow(RestoreError);
    expect(await r.store.exists("new.md")).toBe(true);
  });

  it("restores to a point in time, across a differential chain", async () => {
    const r = rig();
    const originals = await seedVault(r.store, 40);
    r.clock.advance(10 * SECOND);
    await runOk(r.engine, { mode: "full" });
    const at = r.clock.now();
    r.clock.advance(10 * SECOND);
    await r.store.writeBinary("folder0/sub0/note-0.md", enc("changed later"));
    await runOk(r.engine, { mode: "diff" });
    const res = await restoreEngineFor(r).restoreVault({ source: { at: at + SECOND } });
    expect(res.created).toBe(40);
    for (const [path, data] of originals) {
      expect(await r.store.readBinary(`${res.destinationRoot}/${path}`)).toEqual(data);
    }
  });

  it("a second restore into the same restore folder is a no-op", async () => {
    const { r, id } = await scenario();
    const eng = restoreEngineFor(r);
    await eng.restoreVault({ source: { id } });
    expect(await eng.restoreVault({ source: { id } })).toMatchObject({
      created: 0,
      unchanged: 3,
      bytesWritten: 0,
    });
  });
});
