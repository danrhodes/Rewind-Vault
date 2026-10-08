import { describe, expect, it } from "vitest";
import { readText } from "../../src/storage/VaultStore";
import { enc, restoreEngineFor, rig, runOk } from "../support/engineRig";

async function scenario() {
  const r = rig();
  await r.store.seed("keep.md", "keep");
  await r.store.seed("gone.md", "gone v1");
  await r.store.seed("sub/also.md", "also");
  r.clock.advance(10_000);
  const { backupId: fullId } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10_000);
  await r.store.writeBinary("gone.md", enc("gone v2"));
  const { backupId: midId } = await runOk(r.engine, { mode: "diff" });
  r.clock.advance(10_000);
  await r.store.remove("gone.md");
  r.clock.advance(5_000);
  await r.store.remove("sub/also.md");
  const { backupId: lastId } = await runOk(r.engine, { mode: "diff" });
  return { r, fullId, midId, lastId };
}

describe("RestoreEngine.listDeleted", () => {
  it("lists deleted files (by backup time, then path), with the backup holding the last version", async () => {
    const { r, midId, fullId } = await scenario();
    const deleted = await restoreEngineFor(r).listDeleted();
    expect(deleted.map((d) => d.path)).toEqual(["gone.md", "sub/also.md"]);
    expect(deleted.find((d) => d.path === "gone.md")?.lastBackupId).toBe(midId);
    expect(deleted.find((d) => d.path === "sub/also.md")?.lastBackupId).toBe(fullId);
  });

  it("drops files that exist in the vault again", async () => {
    const { r } = await scenario();
    await r.store.seed("gone.md", "recreated by hand");
    expect((await restoreEngineFor(r).listDeleted()).map((d) => d.path)).toEqual(["sub/also.md"]);
  });

  it("is empty with no backups or no deletions", async () => {
    const empty = rig();
    expect(await restoreEngineFor(empty).listDeleted()).toEqual([]);
    const r = rig();
    await r.store.seed("a.md", "a");
    await runOk(r.engine, { mode: "full" });
    expect(await restoreEngineFor(r).listDeleted()).toEqual([]);
  });

  it("the listed backup really restores the last version", async () => {
    const { r } = await scenario();
    const engine = restoreEngineFor(r);
    const gone = (await engine.listDeleted()).find((d) => d.path === "gone.md");
    if (!gone) throw new Error("gone.md should be listed");
    await engine.restoreFiles({
      source: { id: gone.lastBackupId },
      paths: ["gone.md"],
      destination: { kind: "vault" },
    });
    expect(await readText(r.store, "gone.md")).toBe("gone v2");
    expect((await engine.listDeleted()).map((d) => d.path)).toEqual(["sub/also.md"]);
  });
});
