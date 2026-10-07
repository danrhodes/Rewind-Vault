import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { guardStore } from "../../src/core/NonDestructiveGuard";
import { runOptionsForStyle } from "../../src/core/RunStyle";
import { StorageError } from "../../src/helpers/errors";
import type { IVaultStore } from "../../src/storage/VaultStore";
import { enc, rig, seedVault, type Rig, runOk } from "../support/engineRig";
import { idsOf, reconstruct } from "../support/chain";
import { MockVaultStore } from "../mocks/MockVaultStore";

describe("guardStore", () => {
  async function guarded(): Promise<{ raw: MockVaultStore; g: IVaultStore }> {
    const raw = new MockVaultStore();
    await raw.seed("backup/old_full/manifest.json", "{}");
    await raw.seed("backup/old_full/part-001.zip", "zip");
    const g = guardStore(raw, "backup", new Set(["old_full"]));
    return { raw, g };
  }

  it("blocks every mutation inside an existing backup folder", async () => {
    const { raw, g } = await guarded();
    await expect(g.writeBinary("backup/old_full/part-001.zip", enc("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(g.writeBinary("backup/old_full/new.zip", enc("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(g.remove("backup/old_full/manifest.json")).rejects.toBeInstanceOf(StorageError);
    await expect(g.removeFolder("backup/old_full")).rejects.toBeInstanceOf(StorageError);
    await expect(g.rename("backup/old_full/manifest.json", "backup/x.json")).rejects.toBeInstanceOf(
      StorageError,
    );
    await raw.seed("backup/other.json", "{}");
    await expect(
      g.rename("backup/other.json", "backup/old_full/manifest.json"),
    ).rejects.toBeInstanceOf(StorageError);
    expect(await raw.exists("backup/old_full/part-001.zip")).toBe(true);
    expect(new TextDecoder().decode(await raw.readBinary("backup/old_full/part-001.zip"))).toBe(
      "zip",
    );
  });

  it("allows reads, new folders, and the registry files", async () => {
    const { raw, g } = await guarded();
    expect(await g.exists("backup/old_full/manifest.json")).toBe(true);
    expect((await g.list("backup/old_full")).files).toHaveLength(2);
    await g.writeBinary("backup/new_diff/part-001.zip", enc("n"));
    await g.writeBinary("backup/index.json", enc("{}"));
    await g.rename("backup/index.json", "backup/index.json.bak");
    await g.removeFolder("backup/new_diff");
    expect(await raw.exists("backup/new_diff")).toBe(false);
  });

  it("does not confuse a similarly named folder with a protected one", async () => {
    const { g } = await guarded();
    await expect(g.writeBinary("backup/old_full2/a.zip", enc("x"))).resolves.toBeUndefined();
  });
});

describe("non-destructive engine runs", () => {
  /** Records every mutating call so the test can inspect exactly what a run touched. */
  function record(r: Rig): { ops: string[] } {
    const ops: string[] = [];
    const s = r.store;
    const wrap = <K extends "writeBinary" | "remove" | "removeFolder" | "rename">(k: K): void => {
      const original = s[k].bind(s) as (...a: unknown[]) => Promise<void>;
      (s as unknown as Record<string, unknown>)[k] = (...args: unknown[]) => {
        ops.push(`${k} ${args.filter((a) => typeof a === "string").join(" -> ")}`);
        return original(...args);
      };
    };
    (["writeBinary", "remove", "removeFolder", "rename"] as const).forEach(wrap);
    return { ops };
  }

  it("a full chain of runs never touches an earlier backup folder", async () => {
    const r = rig();
    await seedVault(r.store, 20);
    await runOk(r.engine, { mode: "full", nonDestructive: true });

    for (let round = 1; round <= 3; round++) {
      r.clock.advance(1000);
      await r.store.writeBinary(`folder${round}/sub0/note-${round}.md`, enc(`edit ${round}`));
      r.clock.advance(1000);
      const existing = (await r.store.list("backup")).folders;
      const { ops } = record(r);
      await runOk(r.engine, { mode: "diff", nonDestructive: true });
      for (const op of ops) {
        for (const folder of existing)
          expect(op, `${op} touched ${folder}`).not.toContain(`${folder}/`);
        expect(op).not.toMatch(/removeFolder backup\/\d/);
      }
    }
    const index = await loadIndex(r.store, "backup");
    expect(index.backups).toHaveLength(4);
    expect((await r.store.list("backup")).folders).toHaveLength(4);
  });

  it("a failed run removes only its own new folder and leaves older backups intact", async () => {
    const r = rig((p) => void (p.zip.maxFilesPerZip = 5));
    await seedVault(r.store, 20);
    await runOk(r.engine, { mode: "full", nonDestructive: true });
    const before = await reconstruct(r.store, "backup", idsOf(await loadIndex(r.store, "backup")));

    r.clock.advance(1000);
    await r.store.seed("added.md", "x");
    const write = r.store.writeBinary.bind(r.store);
    r.store.writeBinary = async (path, data) => {
      if (path.includes("_diff/") && path.endsWith(".zip.tmp")) throw new Error("disk full");
      return write(path, data);
    };
    await expect(r.engine.run({ mode: "diff", nonDestructive: true })).rejects.toThrow("disk full");
    r.store.writeBinary = write;

    expect((await r.store.list("backup")).folders).toHaveLength(1);
    const after = await reconstruct(r.store, "backup", idsOf(await loadIndex(r.store, "backup")));
    expect(after).toEqual(before);
  });

  it("is reported in the result", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    expect((await runOk(r.engine, { mode: "full", nonDestructive: true })).nonDestructive).toBe(
      true,
    );
    expect((await runOk(r.engine, { mode: "full" })).nonDestructive).toBe(false);
  });
});

describe("runOptionsForStyle", () => {
  it("maps each automatic style", () => {
    expect(runOptionsForStyle("off")).toBeNull();
    expect(runOptionsForStyle("full")).toEqual({ mode: "full" });
    expect(runOptionsForStyle("differential")).toEqual({ mode: "diff" });
    expect(runOptionsForStyle("non-destructive")).toEqual({ mode: "diff", nonDestructive: true });
  });
});
