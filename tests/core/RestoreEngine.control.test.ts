import { describe, expect, it } from "vitest";
import type { RestoreProgress } from "../../src/core/RestoreEngine";
import { CancelledError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

/** 6 files in the backup; afterwards 2 edited and 1 extra file added in the live vault. */
async function scenario(): Promise<{ r: Rig; id: string; names: string[] }> {
  const r = rig((p) => void (p.zip.maxFilesPerZip = 2));
  const names = ["f0.md", "f1.md", "f2.md", "f3.md", "f4.md", "f5.md"];
  for (const n of names) await r.store.seed(`d/${n}`, `orig ${n}`);
  r.clock.advance(10 * SECOND);
  const { backupId: id } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10 * SECOND);
  await r.store.writeBinary("d/f1.md", enc("edited 1"));
  await r.store.writeBinary("d/f4.md", enc("edited 4"));
  await r.store.seed("d/extra.md", "extra");
  return { r, id, names };
}

const vault = (id: string, extra = {}) =>
  ({ source: { id }, destination: { kind: "vault" }, overwrite: true, ...extra }) as const;

describe("restore progress", () => {
  it("reports phases, totals up front, and monotonic counters", async () => {
    const { r, id } = await scenario();
    const seen: RestoreProgress[] = [];
    await restoreEngineFor(r).restoreVault(vault(id, { deleteExtraneous: true }), {
      onProgress: (p) => seen.push(p),
    });
    expect(seen.map((p) => p.phase)).toContain("snapshot");
    expect(seen.map((p) => p.phase)).toContain("deleting");
    const writing = seen.filter((p) => p.phase === "writing");
    expect(writing[writing.length - 1]).toMatchObject({ filesDone: 2, filesTotal: 3 }); // 2 changed + 1 delete
    for (const p of seen) expect(p.filesTotal).toBe(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]?.filesDone).toBeGreaterThanOrEqual(seen[i - 1]?.filesDone ?? 0);
      expect(seen[i]?.bytesDone).toBeGreaterThanOrEqual(seen[i - 1]?.bytesDone ?? 0);
    }
    expect(seen[seen.length - 1]).toMatchObject({ filesDone: 3, phase: "deleting" });
    expect(writing.some((p) => p.currentFile === "d/f1.md")).toBe(true);
  });

  it("reports a full restore folder run with byte totals", async () => {
    const { r, id } = await scenario();
    const seen: RestoreProgress[] = [];
    const res = await restoreEngineFor(r).restoreVault(
      { source: { id } },
      {
        onProgress: (p) => seen.push(p),
      },
    );
    expect(seen[seen.length - 1]).toMatchObject({
      filesDone: 6,
      filesTotal: 6,
      bytesDone: res.bytesWritten,
    });
    expect(seen[seen.length - 1]?.bytesTotal).toBe(res.bytesWritten);
    expect(seen.some((p) => p.phase === "snapshot")).toBe(false);
  });

  it("a throwing progress listener does not fail the restore", async () => {
    const { r, id } = await scenario();
    const res = await restoreEngineFor(r).restoreVault(
      { source: { id } },
      {
        onProgress: () => {
          throw new Error("ui bug");
        },
      },
    );
    expect(res.created).toBe(6);
  });
});

describe("restore cancel", () => {
  it("cancelled before starting writes nothing and takes no snapshot", async () => {
    const { r, id } = await scenario();
    let snaps = 0;
    await expect(
      restoreEngineFor(r, { safetySnapshot: async () => (snaps++, null) }).restoreVault(vault(id), {
        isCancelled: () => true,
      }),
    ).rejects.toThrow(CancelledError);
    expect(snaps).toBe(0);
    expect(await readText(r.store, "d/f1.md")).toBe("edited 1");
  });

  it("cancel after N files stops there; written files are whole, no temp files remain", async () => {
    const { r, id } = await scenario();
    let done = 0;
    await expect(
      restoreEngineFor(r).restoreVault(
        { source: { id } },
        {
          onProgress: (p) => void (done = p.filesDone),
          isCancelled: () => done >= 3,
        },
      ),
    ).rejects.toThrow(CancelledError);
    const root = `restore/${id}/d`;
    const files = (await r.store.list(root)).files;
    expect(files.length).toBe(3);
    for (const f of files) {
      expect(f.endsWith(".tmp") || f.endsWith(".bak")).toBe(false);
      expect(await readText(r.store, f)).toMatch(/^orig f\d\.md$/);
    }
  });

  it("a cancelled restore can simply be run again to completion", async () => {
    const { r, id } = await scenario();
    let done = 0;
    const eng = restoreEngineFor(r);
    await eng
      .restoreVault(
        { source: { id } },
        { onProgress: (p) => void (done = p.filesDone), isCancelled: () => done >= 2 },
      )
      .catch(() => undefined);
    const again = await eng.restoreVault({ source: { id } });
    expect(again.created + again.unchanged).toBe(6);
    expect(again.unchanged).toBe(2);
    for (let i = 0; i < 6; i++) {
      expect(await readText(r.store, `restore/${id}/d/f${i}.md`)).toBe(`orig f${i}.md`);
    }
  });

  it("cancel during deletions stops further deletions", async () => {
    const { r, id } = await scenario();
    await r.store.seed("d/extra2.md", "x");
    let deleted = 0;
    await expect(
      restoreEngineFor(r).restoreVault(vault(id, { deleteExtraneous: true }), {
        onProgress: (p) => void (deleted = p.phase === "deleting" ? p.filesDone - 2 : 0),
        isCancelled: () => deleted >= 1,
      }),
    ).rejects.toThrow(CancelledError);
    const left = [await r.store.exists("d/extra.md"), await r.store.exists("d/extra2.md")];
    expect(left.filter(Boolean).length).toBe(1);
  });

  it("works for restoreFile and restoreFolder too", async () => {
    const { r, id } = await scenario();
    const eng = restoreEngineFor(r);
    await expect(
      eng.restoreFile(
        { source: { id }, path: "d/f0.md", destination: { kind: "restore-folder" } },
        { isCancelled: () => true },
      ),
    ).rejects.toThrow(CancelledError);
    await expect(
      eng.restoreFolder(
        { source: { id }, path: "d", destination: { kind: "restore-folder" } },
        { isCancelled: () => true },
      ),
    ).rejects.toThrow(CancelledError);
    expect(await r.store.exists(`restore/${id}`)).toBe(false);
  });
});
