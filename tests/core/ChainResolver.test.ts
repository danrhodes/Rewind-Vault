import { describe, expect, it } from "vitest";
import { loadIndex, saveIndex, updateBackup } from "../../src/core/BackupIndex";
import { resolveChain } from "../../src/core/ChainResolver";
import { sha256Hex } from "../../src/crypto/hash";
import { BrokenChainError } from "../../src/helpers/errors";
import { enc, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

async function hashesOfVault(r: Rig): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (folder: string): Promise<void> => {
    const l = await r.store.list(folder);
    for (const f of l.files)
      if (!f.startsWith("backup/")) out.set(f, sha256Hex(await r.store.readBinary(f)));
    for (const d of l.folders) if (d !== "backup") await walk(d);
  };
  await walk("");
  return out;
}

interface History {
  r: Rig;
  /** backup id -> hashes of the live vault right after that backup. */
  snapshots: Map<string, Map<string, string>>;
  ids: string[];
  times: number[];
}

/** full -> edit/add/delete diffs -> second full -> more diffs, recording the vault at each step. */
async function buildHistory(): Promise<History> {
  const r = rig();
  const snapshots = new Map<string, Map<string, string>>();
  const ids: string[] = [];
  const times: number[] = [];
  const step = async (mode: "full" | "diff"): Promise<void> => {
    r.clock.advance(10 * SECOND);
    const res = await runOk(r.engine, { mode });
    ids.push(res.backupId);
    times.push(r.clock.now());
    snapshots.set(res.backupId, await hashesOfVault(r));
  };
  const edit = async (path: string, text: string): Promise<void> => {
    r.clock.advance(SECOND);
    await r.store.writeBinary(path, enc(text));
  };

  for (let i = 0; i < 6; i++) await r.store.seed(`d${i % 2}/f${i}.md`, `v1-${i}`);
  await step("full");
  await edit("d0/f0.md", "v2-0");
  await edit("new/a.md", "added");
  await step("diff");
  r.clock.advance(SECOND);
  await r.store.remove("d1/f1.md");
  await edit("d0/f0.md", "v3-0");
  await step("diff");
  await edit("d1/f1.md", "resurrected");
  r.clock.advance(SECOND);
  await r.store.remove("new/a.md");
  await step("diff");
  await edit("d0/f2.md", "before second full");
  await step("full");
  await edit("d1/f3.md", "after second full");
  await step("diff");
  return { r, snapshots, ids, times };
}

const hashesOf = (files: Map<string, { entry: { sha256: string } }>): Map<string, string> =>
  new Map([...files].map(([p, f]) => [p, f.entry.sha256]));

describe("resolveChain by backup id", () => {
  it("reproduces the vault exactly as it was at EVERY backup in the history", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    for (const id of h.ids) {
      const chain = await resolveChain(h.r.store, "backup", index, { id });
      expect(hashesOf(chain.files), `at ${id}`).toEqual(h.snapshots.get(id));
      expect(chain.target.id).toBe(id);
    }
  });

  it("orders links base-first and never mixes chains", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const first = await resolveChain(h.r.store, "backup", index, { id: h.ids[2]! });
    expect(first.links.map((l) => l.backup.id)).toEqual([h.ids[0], h.ids[1], h.ids[2]]);
    const second = await resolveChain(h.r.store, "backup", index, { id: h.ids[5]! });
    expect(second.links.map((l) => l.backup.id)).toEqual([h.ids[4], h.ids[5]]);
  });

  it("each file points at the backup that stores its newest version", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const chain = await resolveChain(h.r.store, "backup", index, { id: h.ids[2]! });
    expect(chain.files.get("d0/f0.md")!.backupId).toBe(h.ids[2]); // edited twice
    expect(chain.files.get("d0/f2.md")!.backupId).toBe(h.ids[0]); // untouched since the full
    expect(chain.files.get("new/a.md")!.backupId).toBe(h.ids[1]);
    expect(chain.files.has("d1/f1.md")).toBe(false); // tombstoned
  });

  it("reports tombstoned paths, and forgets them once re-added", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const afterDelete = await resolveChain(h.r.store, "backup", index, { id: h.ids[2]! });
    expect([...afterDelete.deletedPaths.keys()]).toEqual(["d1/f1.md"]);
    expect(afterDelete.deletedPaths.get("d1/f1.md")).toMatchObject({ lastBackupId: h.ids[0] });
    const afterReadd = await resolveChain(h.r.store, "backup", index, { id: h.ids[3]! });
    expect(afterReadd.files.has("d1/f1.md")).toBe(true);
    expect([...afterReadd.deletedPaths.keys()]).toEqual(["new/a.md"]);
  });

  it("a second full backup resets deletions from before it", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const chain = await resolveChain(h.r.store, "backup", index, { id: h.ids[4]! });
    expect(chain.deletedPaths.size).toBe(0);
    expect(chain.links).toHaveLength(1);
  });
});

describe("resolveChain at a point in time", () => {
  it("picks the newest backup at or before the moment", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const at = (t: number) => resolveChain(h.r.store, "backup", index, { at: t });
    expect((await at(h.times[0]!)).target.id).toBe(h.ids[0]); // exactly at a backup
    expect((await at(h.times[1]! + 5 * SECOND)).target.id).toBe(h.ids[1]); // between two
    expect((await at(h.times[5]! + 10 ** 9)).target.id).toBe(h.ids[5]); // long after
    expect(hashesOf((await at(h.times[2]! + SECOND)).files)).toEqual(h.snapshots.get(h.ids[2]!));
  });

  it("fails clearly when nothing exists that early", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    await expect(
      resolveChain(h.r.store, "backup", index, { at: h.times[0]! - 10 ** 9 }),
    ).rejects.toThrow("no intact backup");
  });

  it("ignores backups that are not intact when choosing by time", async () => {
    const h = await buildHistory();
    let index = await loadIndex(h.r.store, "backup");
    index = updateBackup(index, h.ids[1]!, { status: "corrupt" });
    const chain = await resolveChain(h.r.store, "backup", index, { at: h.times[1]! + SECOND });
    expect(chain.target.id).toBe(h.ids[0]);
  });
});

describe("resolveChain refuses broken chains", () => {
  const expectBroken = (p: Promise<unknown>, fragment: string): Promise<void> =>
    expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof BrokenChainError && e.message.includes(fragment),
    );

  it("unknown backup id", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    await expectBroken(
      resolveChain(h.r.store, "backup", index, { id: "nope" }),
      "not in the backup index",
    );
  });

  it("a corrupt link anywhere in the chain", async () => {
    const h = await buildHistory();
    let index = await loadIndex(h.r.store, "backup");
    index = updateBackup(index, h.ids[1]!, { status: "corrupt" });
    await expectBroken(
      resolveChain(h.r.store, "backup", index, { id: h.ids[2]! }),
      "marked corrupt",
    );
    // The other chain is unaffected.
    await expect(
      resolveChain(h.r.store, "backup", index, { id: h.ids[5]! }),
    ).resolves.toBeDefined();
  });

  it("a corrupt target", async () => {
    const h = await buildHistory();
    const index = updateBackup(await loadIndex(h.r.store, "backup"), h.ids[3]!, {
      status: "partial",
    });
    await expectBroken(
      resolveChain(h.r.store, "backup", index, { id: h.ids[3]! }),
      "marked partial",
    );
  });

  it("a backup folder that has gone missing", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    await h.r.store.removeFolder(`backup/${h.ids[1]}`);
    await expectBroken(
      resolveChain(h.r.store, "backup", index, { id: h.ids[2]! }),
      "missing or its manifest is damaged",
    );
  });

  it("a damaged manifest", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    await h.r.store.seed(`backup/${h.ids[0]}/manifest.json`, "{ broken");
    await expectBroken(resolveChain(h.r.store, "backup", index, { id: h.ids[1]! }), "damaged");
  });

  it("the base full backup removed from the index", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const without = { ...index, backups: index.backups.filter((b) => b.id !== h.ids[0]) };
    await expectBroken(
      resolveChain(h.r.store, "backup", without, { id: h.ids[2]! }),
      "full backup it builds on",
    );
  });

  it("an index entry that disagrees with its manifest", async () => {
    const h = await buildHistory();
    const index = await loadIndex(h.r.store, "backup");
    const lying = {
      ...index,
      backups: index.backups.map((b) =>
        b.id === h.ids[1] ? { ...b, type: "full" as const, baseId: null } : b,
      ),
    };
    await saveIndex(h.r.store, "backup", lying);
    await expectBroken(
      resolveChain(h.r.store, "backup", lying, { id: h.ids[1]! }),
      "does not match the index",
    );
  });
});
