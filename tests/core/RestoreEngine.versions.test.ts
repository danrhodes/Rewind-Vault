import { describe, expect, it } from "vitest";
import { RestoreError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

async function step(r: Rig, mode: "full" | "diff"): Promise<string> {
  r.clock.advance(10 * SECOND);
  return (await runOk(r.engine, { mode })).backupId;
}

/**
 * n.md history: v1 (full) -> untouched while other.md changes (diff) -> "version two" (diff)
 * -> deleted (diff) -> re-created as "v3 again" (diff) -> unchanged in a second full.
 */
async function history(): Promise<{ r: Rig; ids: string[] }> {
  const r = rig();
  await r.store.seed("n.md", "v1");
  await r.store.seed("other.md", "o1");
  const ids: string[] = [await step(r, "full")];
  await r.store.writeBinary("other.md", enc("o2"));
  ids.push(await step(r, "diff"));
  await r.store.writeBinary("n.md", enc("version two"));
  ids.push(await step(r, "diff"));
  await r.store.remove("n.md");
  ids.push(await step(r, "diff"));
  await r.store.seed("n.md", "v3 again");
  ids.push(await step(r, "diff"));
  ids.push(await step(r, "full"));
  return { r, ids };
}

describe("listFileVersions", () => {
  it("lists distinct versions oldest first, skipping unchanged copies", async () => {
    const { r, ids } = await history();
    const v = await restoreEngineFor(r).listFileVersions("n.md");
    expect(v.map((x) => [x.kind, x.backupId])).toEqual([
      ["present", ids[0]],
      ["present", ids[2]],
      ["deleted", ids[3]],
      ["present", ids[4]],
    ]);
    expect(v.map((x) => x.size)).toEqual(["v1".length, "version two".length, undefined, 8]);
    expect(v[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v[3]?.createdAt).toBeGreaterThan(v[0]?.createdAt ?? 0);
  });

  it("detects deletion by absence from a later full backup", async () => {
    const r = rig();
    await r.store.seed("n.md", "v1");
    await r.store.seed("keep.md", "k");
    const a = await step(r, "full");
    await r.store.remove("n.md");
    const b = await step(r, "full");
    const v = await restoreEngineFor(r).listFileVersions("n.md");
    expect(v.map((x) => [x.kind, x.backupId])).toEqual([
      ["present", a],
      ["deleted", b],
    ]);
  });

  it("returns [] for a file that was never backed up and rejects unsafe paths", async () => {
    const { r } = await history();
    const eng = restoreEngineFor(r);
    expect(await eng.listFileVersions("nope.md")).toEqual([]);
    await expect(eng.listFileVersions("../x")).rejects.toThrow(RestoreError);
  });

  it("skips backups that are not intact", async () => {
    const { r, ids } = await history();
    const raw = JSON.parse(await readText(r.store, "backup/index.json")) as {
      backups: { id: string; status: string }[];
    };
    const hit = raw.backups.find((b) => b.id === ids[2]);
    if (hit) hit.status = "corrupt";
    await r.store.seed("backup/index.json", JSON.stringify(raw));
    const v = await restoreEngineFor(r).listFileVersions("n.md");
    expect(v.map((x) => x.backupId)).not.toContain(ids[2]);
  });
});

describe("restoreFileVersion", () => {
  it("restores each present version's exact content into its own restore folder", async () => {
    const { r, ids } = await history();
    const eng = restoreEngineFor(r);
    const expected = ["v1", "version two", "v3 again"];
    const present = (await eng.listFileVersions("n.md")).filter((x) => x.kind === "present");
    expect(present.map((p) => p.backupId)).toEqual([ids[0], ids[2], ids[4]]);
    for (const [i, version] of present.entries()) {
      const res = await eng.restoreFileVersion({ path: "n.md", backupId: version.backupId });
      expect(res.writtenTo).toBe(`restore/${version.backupId}/n.md`);
      expect(await readText(r.store, res.writtenTo)).toBe(expected[i]);
    }
  });

  it("can restore a version over the live file with overwrite (after a snapshot)", async () => {
    const { r, ids } = await history();
    await r.store.writeBinary("n.md", enc("unsaved live edit"));
    const before = (await r.store.list("backup")).folders.length;
    const res = await restoreEngineFor(r).restoreFileVersion({
      path: "n.md",
      backupId: ids[0] as string,
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(res.outcome).toBe("replaced");
    expect(await readText(r.store, "n.md")).toBe("v1");
    expect((await r.store.list("backup")).folders.length).toBe(before + 1);
  });

  it("rejects the deleted version", async () => {
    const { r, ids } = await history();
    await expect(
      restoreEngineFor(r).restoreFileVersion({ path: "n.md", backupId: ids[3] as string }),
    ).rejects.toThrow(/not in backup/);
  });
});
