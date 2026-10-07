import { describe, expect, it } from "vitest";
import { planRetention } from "../../src/core/Retention";
import { DAY, NOW, indexOf, noRules, prunedIds, retention } from "../support/retentionFixtures";

const fulls = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `b${i + 1}`, age: (count - i) * DAY }));
// b1 is the OLDEST, b<count> the newest.

describe("planRetention: keep last N", () => {
  it("prunes everything older than the newest N intact backups", () => {
    const plan = planRetention(indexOf(...fulls(6)), noRules({ keepLast: 3 }), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2", "b3"]);
    expect([...plan.keep.keys()].sort()).toEqual(["b4", "b5", "b6"]);
    expect(plan.keep.get("b6")).toContain("keep-last");
  });

  it("prunes nothing when there are N or fewer", () => {
    expect(planRetention(indexOf(...fulls(3)), noRules({ keepLast: 3 }), NOW).prune).toEqual([]);
    expect(planRetention(indexOf(...fulls(2)), noRules({ keepLast: 3 }), NOW).prune).toEqual([]);
    expect(planRetention(indexOf(), noRules({ keepLast: 3 }), NOW).prune).toEqual([]);
  });

  it("with no rule enabled (keep last = 0) nothing is ever pruned", () => {
    const plan = planRetention(indexOf(...fulls(8)), noRules(), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("b1")).toEqual(["no-policy"]);
  });

  it("negative or fractional values are handled (fraction floors, negative disables)", () => {
    expect(prunedIds(planRetention(indexOf(...fulls(5)), noRules({ keepLast: 2.9 }), NOW))).toEqual(
      ["b1", "b2", "b3"],
    );
    expect(planRetention(indexOf(...fulls(5)), noRules({ keepLast: -4 }), NOW).prune).toEqual([]);
  });

  it("keep last 1 keeps exactly the newest", () => {
    const plan = planRetention(indexOf(...fulls(4)), noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2", "b3"]);
  });

  it("does not depend on the order of the index", () => {
    const shuffled = indexOf(...fulls(6).reverse());
    expect(prunedIds(planRetention(shuffled, noRules({ keepLast: 2 }), NOW))).toEqual([
      "b1",
      "b2",
      "b3",
      "b4",
    ]);
  });

  it("breaks a same-instant tie deterministically", () => {
    const index = indexOf({ id: "a", age: DAY }, { id: "b", age: DAY }, { id: "c", age: DAY });
    const first = prunedIds(planRetention(index, noRules({ keepLast: 1 }), NOW));
    const second = prunedIds(planRetention(index, noRules({ keepLast: 1 }), NOW));
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });

  it("is pure: the index is not modified", () => {
    const index = indexOf(...fulls(5));
    const before = JSON.stringify(index);
    planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(JSON.stringify(index)).toBe(before);
  });
});

describe("planRetention: never prune the last good backup", () => {
  it("corrupt backups do not count toward N and are never pruned", () => {
    // newest two are corrupt; keep last 1 must keep the newest INTACT one.
    const index = indexOf(
      { id: "old", age: 4 * DAY },
      { id: "good", age: 3 * DAY },
      { id: "bad1", age: 2 * DAY, status: "corrupt" },
      { id: "bad2", age: DAY, status: "corrupt" },
    );
    const plan = planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["old"]);
    expect(plan.keep.get("good")).toContain("newest-intact");
    expect(plan.keep.get("bad1")).toEqual(["not-intact"]);
    expect(plan.keep.get("bad2")).toEqual(["not-intact"]);
  });

  it("partial and in-progress backups are left alone too", () => {
    const index = indexOf(
      { id: "a", age: 3 * DAY },
      { id: "b", age: 2 * DAY },
      { id: "p", age: DAY, status: "partial" },
      { id: "w", age: DAY / 2, status: "in-progress" },
    );
    expect(prunedIds(planRetention(index, noRules({ keepLast: 1 }), NOW))).toEqual(["a"]);
  });

  it("with only corrupt backups nothing is pruned", () => {
    const index = indexOf(
      { id: "x", age: 2 * DAY, status: "corrupt" },
      { id: "y", age: DAY, status: "corrupt" },
    );
    expect(planRetention(index, noRules({ keepLast: 1 }), NOW).prune).toEqual([]);
  });

  it("a corrupt backup pushing in front does not evict a good one", () => {
    const index = indexOf(
      { id: "g1", age: 3 * DAY },
      { id: "g2", age: 2 * DAY },
      { id: "bad", age: DAY, status: "corrupt" },
    );
    expect(planRetention(index, noRules({ keepLast: 2 }), NOW).prune).toEqual([]);
  });

  it("for every N from 1..8 over a mixed history at least one intact backup survives", () => {
    const index = indexOf(
      { id: "a", age: 9 * DAY },
      { id: "b", age: 8 * DAY, status: "corrupt" },
      { id: "c", age: 7 * DAY },
      { id: "d", age: 6 * DAY, status: "corrupt" },
      { id: "e", age: 5 * DAY },
      { id: "f", age: 4 * DAY, status: "partial" },
      { id: "g", age: 3 * DAY },
      { id: "h", age: 2 * DAY, status: "corrupt" },
    );
    for (let n = 1; n <= 8; n++) {
      const plan = planRetention(index, noRules({ keepLast: n }), NOW);
      const gone = new Set(plan.prune.map((p) => p.id));
      const survivors = index.backups.filter((b) => b.status === "ok" && !gone.has(b.id));
      expect(survivors.length, `keepLast=${n}`).toBeGreaterThan(0);
      expect(plan.prune.every((p) => p.status === "ok")).toBe(true);
    }
  });
});

describe("planRetention: pinned backups", () => {
  it("are kept when pinnedExempt is on", () => {
    const index = indexOf(
      { id: "milestone", age: 9 * DAY, pinned: true },
      { id: "b", age: 3 * DAY },
      { id: "c", age: 2 * DAY },
      { id: "d", age: DAY },
    );
    const plan = planRetention(index, noRules({ keepLast: 1, pinnedExempt: true }), NOW);
    expect(prunedIds(plan)).toEqual(["b", "c"]);
    expect(plan.keep.get("milestone")).toEqual(["pinned"]);
  });

  it("get no special treatment when pinnedExempt is off", () => {
    const index = indexOf({ id: "milestone", age: 9 * DAY, pinned: true }, { id: "d", age: DAY });
    const plan = planRetention(index, noRules({ keepLast: 1, pinnedExempt: false }), NOW);
    expect(prunedIds(plan)).toEqual(["milestone"]);
  });

  it("use the default settings without throwing", () => {
    const plan = planRetention(indexOf(...fulls(12)), retention(), NOW);
    expect(prunedIds(plan)).toEqual(["b1", "b2"]);
  });
});
