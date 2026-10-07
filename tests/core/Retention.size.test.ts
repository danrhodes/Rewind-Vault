import { describe, expect, it } from "vitest";
import { loadIndex, saveIndex } from "../../src/core/BackupIndex";
import { planRetention } from "../../src/core/Retention";
import { applyRetention } from "../../src/core/RetentionApply";
import { enc, rig, runOk, type Rig } from "../support/engineRig";
import { DAY, NOW, indexOf, noRules, prunedIds } from "../support/retentionFixtures";

const MB = 1024 * 1024;

/** Five full backups of 10 MB each, b1 oldest. */
const fiveFulls = (overrides: Record<string, object> = {}) =>
  indexOf(
    ...[1, 2, 3, 4, 5].map((n) => ({
      id: `b${n}`,
      age: (6 - n) * DAY,
      size: 10 * MB,
      ...overrides[`b${n}`],
    })),
  );

describe("planRetention: max folder size", () => {
  it("removes the oldest backups until the total fits", () => {
    const plan = planRetention(fiveFulls(), noRules({ maxFolderMb: 25 }), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2", "b3"]); // 50 MB -> 20 MB
    expect(plan.sizeCapUnmet).toBe(false);
  });

  it("stops as soon as the total is under the cap (not one backup more)", () => {
    const plan = planRetention(fiveFulls(), noRules({ maxFolderMb: 30 }), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2"]); // 30 MB is exactly at the cap
  });

  it("does nothing when under the cap, or when the cap is 0 (off)", () => {
    expect(planRetention(fiveFulls(), noRules({ maxFolderMb: 50 }), NOW).prune).toEqual([]);
    expect(planRetention(fiveFulls(), noRules({ maxFolderMb: 0 }), NOW).prune).toEqual([]);
    expect(planRetention(fiveFulls(), noRules({ maxFolderMb: -5 }), NOW).prune).toEqual([]);
  });

  it("overrides keep last, because the cap is a hard limit", () => {
    const plan = planRetention(fiveFulls(), noRules({ keepLast: 5, maxFolderMb: 25 }), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2", "b3"]);
  });

  it("never removes the newest intact backup, and reports the cap as unmet", () => {
    const plan = planRetention(fiveFulls(), noRules({ maxFolderMb: 4 }), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(plan.keep.get("b5")).toContain("newest-intact");
    expect(plan.sizeCapUnmet).toBe(true);
  });

  it("skips pinned backups (their size still counts) and takes the next oldest", () => {
    const plan = planRetention(
      fiveFulls({ b1: { pinned: true } }),
      noRules({ maxFolderMb: 25, pinnedExempt: true }),
      NOW,
    );
    expect(prunedIds(plan)).toEqual(["b2", "b3", "b4"]); // 50 -> 20 MB, b1 and b5 stay
    expect(plan.keep.get("b1")).toContain("pinned");
  });

  it("a pinned backup does not stop the cap from removing others when pinnedExempt is off", () => {
    const plan = planRetention(
      fiveFulls({ b1: { pinned: true } }),
      noRules({ maxFolderMb: 25, pinnedExempt: false }),
      NOW,
    );
    expect(prunedIds(plan)).toEqual(["b1", "b2", "b3"]);
  });

  it("counts corrupt backups toward the total but never removes them", () => {
    const plan = planRetention(
      fiveFulls({ b2: { status: "corrupt" } }),
      noRules({ maxFolderMb: 25 }),
      NOW,
    );
    // total 50; b1 and b3 and b4 go -> 20 MB; corrupt b2 stays.
    expect(prunedIds(plan)).toEqual(["b1", "b3", "b4"]);
    expect(plan.keep.get("b2")).toEqual(["not-intact"]);
  });

  it("with only protected backups left it stops without looping or throwing", () => {
    const plan = planRetention(
      fiveFulls({ b1: { status: "corrupt" }, b2: { status: "corrupt" } }),
      noRules({ maxFolderMb: 1 }),
      NOW,
    );
    expect(prunedIds(plan)).toEqual(["b3", "b4"]);
    expect(plan.sizeCapUnmet).toBe(true);
  });
});

describe("planRetention: max folder size and differential chains", () => {
  const chains = (extra: Record<string, object> = {}) =>
    indexOf(
      { id: "F1", age: 6 * DAY, size: 10 * MB, ...extra.F1 },
      { id: "D1", age: 5 * DAY, size: 2 * MB, type: "diff", baseId: "F1", ...extra.D1 },
      { id: "D2", age: 4 * DAY, size: 2 * MB, type: "diff", baseId: "F1", ...extra.D2 },
      { id: "F2", age: 3 * DAY, size: 10 * MB, ...extra.F2 },
      { id: "D3", age: 2 * DAY, size: 2 * MB, type: "diff", baseId: "F2", ...extra.D3 },
    );

  it("removes an old full together with the diffs that depend on it", () => {
    const plan = planRetention(chains(), noRules({ maxFolderMb: 15 }), NOW);
    expect(prunedIds(plan)).toEqual(["D1", "D2", "F1"]); // 26 -> 12 MB
  });

  it("never leaves a diff without its base", () => {
    for (const cap of [1, 5, 12, 13, 20, 25]) {
      const plan = planRetention(chains(), noRules({ maxFolderMb: cap }), NOW);
      const gone = new Set(plan.prune.map((b) => b.id));
      if (gone.has("F1")) {
        expect(gone.has("D1") && gone.has("D2"), `cap ${cap}`).toBe(true);
      }
      if (gone.has("F2")) expect(gone.has("D3"), `cap ${cap}`).toBe(true);
    }
  });

  it("skips an old chain when a pinned backup depends on it, and moves on", () => {
    const plan = planRetention(
      chains({ D2: { pinned: true } }),
      noRules({ maxFolderMb: 15, pinnedExempt: true }),
      NOW,
    );
    // F1 and D1 are needed by pinned D2, so they stay; D2 itself is pinned. Newest chain is
    // protected through newest-intact (D3). Nothing can go: cap unmet.
    expect(plan.prune).toEqual([]);
    expect(plan.sizeCapUnmet).toBe(true);
  });

  it("never removes the chain of the newest intact backup", () => {
    const plan = planRetention(chains(), noRules({ maxFolderMb: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["D1", "D2", "F1"]);
    expect(plan.keep.has("F2")).toBe(true);
  });

  it("a corrupt diff on an old full does not block removing that full", () => {
    const plan = planRetention(
      chains({ D1: { status: "corrupt" } }),
      noRules({ maxFolderMb: 15 }),
      NOW,
    );
    expect(prunedIds(plan)).toEqual(["D2", "F1"]);
    expect(plan.keep.get("D1")).toEqual(["not-intact"]);
  });
});

describe("max folder size: applying to disk", () => {
  async function history(): Promise<Rig> {
    const r = rig((p) => {
      p.retention.keepLast = 0;
    });
    await r.store.seed("a.md", "a");
    for (let i = 0; i < 4; i++) {
      r.clock.advance(60_000);
      await r.store.writeBinary("a.md", enc(`a${i}`));
      await runOk(r.engine, { mode: "full" });
    }
    // Pretend each backup is 5 MB so a cap in whole MB can be exercised.
    const index = await loadIndex(r.store, "backup");
    await saveIndex(r.store, "backup", {
      ...index,
      backups: index.backups.map((b) => ({ ...b, size: 5 * MB })),
    });
    return r;
  }

  it("deletes the oldest folders and updates the index", async () => {
    const r = await history();
    const before = (await loadIndex(r.store, "backup")).backups
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((b) => b.id);
    const result = await applyRetention({
      store: r.store,
      logger: r.logger,
      backupFolder: "backup",
      settings: { ...r.profile.retention, maxFolderMb: 12 },
      now: r.clock.now(),
    });
    expect(result.pruned.sort()).toEqual(before.slice(0, 2).sort());
    const folders = (await r.store.list("backup")).folders.map((f) => f.slice("backup/".length));
    expect(folders.sort()).toEqual(before.slice(2).sort());
    expect((await loadIndex(r.store, "backup")).backups.map((b) => b.id).sort()).toEqual(
      before.slice(2).sort(),
    );
  });
});
