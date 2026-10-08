import { describe, expect, it } from "vitest";
import { enc, restoreEngineFor, rig, runOk } from "../support/engineRig";

async function scenario() {
  const r = rig();
  await r.store.seed("a.md", "a1");
  await r.store.seed("sub/b.md", "b1");
  r.clock.advance(10_000);
  const { backupId: fullId } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10_000);
  await r.store.writeBinary("a.md", enc("a2 longer"));
  await r.store.seed("c.md", "c1");
  await r.store.remove("sub/b.md");
  const { backupId: diffId } = await runOk(r.engine, { mode: "diff" });
  return { r, fullId, diffId };
}

describe("RestoreEngine time travel", () => {
  it("lists intact backups newest first", async () => {
    const { r, fullId, diffId } = await scenario();
    const points = await restoreEngineFor(r).listPoints();
    expect(points.map((p) => p.id)).toEqual([diffId, fullId]);
  });

  it("lists the files as they were at each backup, sorted by path", async () => {
    const { r, fullId, diffId } = await scenario();
    const engine = restoreEngineFor(r);
    expect((await engine.listFilesAt({ id: fullId })).map((f) => f.path)).toEqual([
      "a.md",
      "sub/b.md",
    ]);
    const later = await engine.listFilesAt({ id: diffId });
    expect(later.map((f) => f.path)).toEqual(["a.md", "c.md"]);
    expect(later[0]?.size).toBe(9);
  });

  it("reads the content a file had at a point", async () => {
    const { r, fullId } = await scenario();
    const engine = restoreEngineFor(r);
    expect(new TextDecoder().decode(await engine.readFile({ id: fullId }, "a.md"))).toBe("a1");
  });

  it("is empty without backups and rejects an unknown backup", async () => {
    const empty = rig();
    expect(await restoreEngineFor(empty).listPoints()).toEqual([]);
    await expect(restoreEngineFor(empty).listFilesAt({ id: "nope" })).rejects.toThrow();
  });
});
