import { describe, expect, it } from "vitest";
import { loadIndex, saveIndex, updateBackup } from "../../src/core/BackupIndex";
import { planRetention } from "../../src/core/Retention";
import { reconstruct } from "../support/chain";
import { enc, rig, runOk } from "../support/engineRig";
import {
  DAY,
  NOW,
  indexOf,
  noRules,
  prunedIds,
  type EntrySpec,
} from "../support/retentionFixtures";

const MB = 1024 * 1024;

/** An old pinned milestone plus a run of ordinary backups. */
const withMilestone = (): EntrySpec[] => [
  { id: "milestone", age: 400 * DAY, pinned: true, size: 20 * MB },
  { id: "a", age: 30 * DAY, size: 10 * MB },
  { id: "b", age: 20 * DAY, size: 10 * MB },
  { id: "c", age: 10 * DAY, size: 10 * MB },
  { id: "d", age: DAY, size: 10 * MB },
];

describe("pinned milestones are exempt from every retention rule", () => {
  it("keep last N", () => {
    const plan = planRetention(indexOf(...withMilestone()), noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["a", "b", "c"]);
    expect(plan.keep.get("milestone")).toEqual(["pinned"]);
  });

  it("keep N days", () => {
    const plan = planRetention(indexOf(...withMilestone()), noRules({ keepDays: 5 }), NOW);
    expect(prunedIds(plan)).toEqual(["a", "b", "c"]);
    expect(plan.keep.has("milestone")).toBe(true);
  });

  it("GFS", () => {
    const plan = planRetention(
      indexOf(...withMilestone()),
      noRules({ gfsEnabled: true, gfsDaily: 1, gfsWeekly: 0, gfsMonthly: 0 }),
      NOW,
    );
    expect(prunedIds(plan)).toEqual(["a", "b", "c"]);
    expect(plan.keep.has("milestone")).toBe(true);
  });

  it("max folder size (its size still counts toward the total)", () => {
    // total 60 MB, cap 35: milestone (20) + d (10) = 30 fits once a, b, c go.
    const plan = planRetention(indexOf(...withMilestone()), noRules({ maxFolderMb: 35 }), NOW);
    expect(prunedIds(plan)).toEqual(["a", "b", "c"]);
    expect(plan.sizeCapUnmet).toBe(false);
  });

  it("all rules at once", () => {
    const plan = planRetention(
      indexOf(...withMilestone()),
      noRules({
        keepLast: 1,
        keepDays: 2,
        gfsEnabled: true,
        gfsDaily: 1,
        gfsWeekly: 1,
        gfsMonthly: 1,
        maxFolderMb: 1,
      }),
      NOW,
    );
    expect(plan.keep.has("milestone")).toBe(true);
    expect(plan.prune.some((b) => b.id === "milestone")).toBe(false);
  });

  it("a cap smaller than the pinned backup alone is reported as unmet, not forced", () => {
    const plan = planRetention(indexOf(...withMilestone()), noRules({ maxFolderMb: 5 }), NOW);
    expect(plan.keep.has("milestone")).toBe(true);
    expect(plan.sizeCapUnmet).toBe(true);
  });
});

describe("pinned backups: the exempt switch and edge cases", () => {
  it("pinnedExempt off removes the exemption for every rule", () => {
    const plan = planRetention(
      indexOf(...withMilestone()),
      noRules({ keepLast: 1, pinnedExempt: false }),
      NOW,
    );
    expect(prunedIds(plan)).toEqual(["a", "b", "c", "milestone"]);
  });

  it("many pinned backups are all kept", () => {
    const specs: EntrySpec[] = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      age: (100 + i) * DAY,
      pinned: i % 2 === 0,
    }));
    specs.push({ id: "new", age: DAY });
    const plan = planRetention(indexOf(...specs), noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["p1", "p3", "p5"]);
  });

  it("pinning a corrupt backup changes nothing: corrupt backups are never pruned anyway", () => {
    const plan = planRetention(
      indexOf(
        { id: "bad", age: 50 * DAY, status: "corrupt", pinned: true },
        { id: "ok", age: DAY },
      ),
      noRules({ keepLast: 1 }),
      NOW,
    );
    expect(plan.prune).toEqual([]);
  });

  it("a pinned diff keeps its whole chain alive", () => {
    const plan = planRetention(
      indexOf(
        { id: "F", age: 90 * DAY },
        { id: "D1", age: 80 * DAY, type: "diff", baseId: "F" },
        { id: "D2", age: 70 * DAY, type: "diff", baseId: "F", pinned: true },
        { id: "F2", age: 2 * DAY },
      ),
      noRules({ keepLast: 1 }),
      NOW,
    );
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("F")).toEqual(["chain-dependency"]);
    expect(plan.keep.get("D1")).toEqual(["chain-dependency"]);
  });

  it("a pinned backup still counts toward keep last N (it is not an extra)", () => {
    // Newest two are kept by the rule; the pinned old one is kept on top.
    const plan = planRetention(indexOf(...withMilestone()), noRules({ keepLast: 2 }), NOW);
    expect(prunedIds(plan)).toEqual(["a", "b"]);
  });
});

describe("pinned milestones through the engine", () => {
  it("a pinned backup survives later runs and still restores exactly", async () => {
    const r = rig((p) => {
      p.retention.keepLast = 1;
    });
    await r.store.seed("a.md", "milestone content");
    r.clock.advance(60_000);
    const first = await runOk(r.engine, { mode: "full" });

    const index = await loadIndex(r.store, "backup");
    await saveIndex(
      r.store,
      "backup",
      updateBackup(index, first.backupId, { pinned: true, label: "v1.0" }),
    );

    for (let i = 0; i < 4; i++) {
      r.clock.advance(60_000);
      await r.store.writeBinary("a.md", enc(`edit ${i}`));
      await runOk(r.engine, { mode: "full" });
    }

    const after = await loadIndex(r.store, "backup");
    expect(after.backups).toHaveLength(2); // the milestone + the newest
    const kept = after.backups.find((b) => b.id === first.backupId);
    expect(kept?.pinned).toBe(true);
    expect(kept?.label).toBe("v1.0");
    const files = await reconstruct(r.store, "backup", [first.backupId]);
    expect(new TextDecoder().decode(files.get("a.md"))).toBe("milestone content");
  });

  it("unpinning makes it eligible on the next run", async () => {
    const r = rig((p) => {
      p.retention.keepLast = 1;
    });
    await r.store.seed("a.md", "x");
    r.clock.advance(60_000);
    const first = await runOk(r.engine, { mode: "full" });
    let index = await loadIndex(r.store, "backup");
    await saveIndex(r.store, "backup", updateBackup(index, first.backupId, { pinned: true }));
    r.clock.advance(60_000);
    await r.store.writeBinary("a.md", enc("y"));
    await runOk(r.engine, { mode: "full" });
    expect((await loadIndex(r.store, "backup")).backups).toHaveLength(2);

    index = await loadIndex(r.store, "backup");
    await saveIndex(r.store, "backup", updateBackup(index, first.backupId, { pinned: false }));
    r.clock.advance(60_000);
    await r.store.writeBinary("a.md", enc("z"));
    const third = await runOk(r.engine, { mode: "full" });
    expect(third.retention?.pruned).toContain(first.backupId);
  });
});
