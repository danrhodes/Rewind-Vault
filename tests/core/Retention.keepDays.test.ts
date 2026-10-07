import { describe, expect, it } from "vitest";
import { planRetention } from "../../src/core/Retention";
import { DAY, NOW, indexOf, noRules, prunedIds } from "../support/retentionFixtures";

const history = () =>
  indexOf(
    { id: "d40", age: 40 * DAY },
    { id: "d20", age: 20 * DAY },
    { id: "d10", age: 10 * DAY },
    { id: "d3", age: 3 * DAY },
    { id: "d1", age: DAY },
  );

describe("planRetention: keep N days", () => {
  it("prunes intact backups older than N days", () => {
    const plan = planRetention(history(), noRules({ keepDays: 14 }), NOW);
    expect(prunedIds(plan)).toEqual(["d20", "d40"]);
    expect(plan.keep.get("d10")).toContain("keep-days");
  });

  it("keeps a backup that is exactly N days old and prunes one a millisecond older", () => {
    const index = indexOf(
      { id: "edge", age: 7 * DAY },
      { id: "over", age: 7 * DAY + 1 },
      {
        id: "new",
        age: DAY,
      },
    );
    expect(prunedIds(planRetention(index, noRules({ keepDays: 7 }), NOW))).toEqual(["over"]);
  });

  it("0 (or negative) switches the rule off", () => {
    expect(planRetention(history(), noRules({ keepDays: 0 }), NOW).prune).toEqual([]);
    expect(planRetention(history(), noRules({ keepDays: -3 }), NOW).prune).toEqual([]);
  });

  it("fractional days work (half a day = 12 hours)", () => {
    const index = indexOf(
      { id: "old", age: 13 * 60 * 60 * 1000 },
      { id: "recent", age: 11 * 60 * 60 * 1000 },
    );
    expect(prunedIds(planRetention(index, noRules({ keepDays: 0.5 }), NOW))).toEqual(["old"]);
  });

  it("combines with keep last as a union: either rule keeps a backup", () => {
    // keep last 2 = d3, d1 ; keep 14 days = d10, d3, d1 -> d20 and d40 go.
    const both = planRetention(history(), noRules({ keepLast: 2, keepDays: 14 }), NOW);
    expect(prunedIds(both)).toEqual(["d20", "d40"]);
    // keep last 3 = d10, d3, d1 ; keep 30 days adds d20 -> only d40 goes.
    const wider = planRetention(history(), noRules({ keepLast: 3, keepDays: 30 }), NOW);
    expect(prunedIds(wider)).toEqual(["d40"]);
    // each reason is recorded
    expect(wider.keep.get("d3")).toEqual(expect.arrayContaining(["keep-last", "keep-days"]));
    expect(wider.keep.get("d20")).toEqual(["keep-days"]);
  });

  it("when every backup is older than N days the newest intact one is still kept", () => {
    const index = indexOf(
      { id: "a", age: 90 * DAY },
      { id: "b", age: 60 * DAY },
      {
        id: "c",
        age: 50 * DAY,
      },
    );
    const plan = planRetention(index, noRules({ keepDays: 7 }), NOW);
    expect(prunedIds(plan)).toEqual(["a", "b"]);
    expect(plan.keep.get("c")).toEqual(["newest-intact"]);
  });

  it("does not count or delete corrupt backups, however old", () => {
    const index = indexOf(
      { id: "bad", age: 100 * DAY, status: "corrupt" },
      { id: "old", age: 50 * DAY },
      { id: "new", age: DAY },
    );
    const plan = planRetention(index, noRules({ keepDays: 7 }), NOW);
    expect(prunedIds(plan)).toEqual(["old"]);
    expect(plan.keep.get("bad")).toEqual(["not-intact"]);
  });

  it("an old pinned backup is exempt, and an old diff stays while a young diff needs it", () => {
    const pinned = indexOf({ id: "ms", age: 90 * DAY, pinned: true }, { id: "new", age: DAY });
    expect(planRetention(pinned, noRules({ keepDays: 7 }), NOW).prune).toEqual([]);

    const chain = indexOf(
      { id: "F", age: 30 * DAY },
      { id: "D1", age: 20 * DAY, type: "diff", baseId: "F" },
      { id: "D2", age: DAY, type: "diff", baseId: "F" },
    );
    const plan = planRetention(chain, noRules({ keepDays: 7 }), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("F")).toEqual(["chain-dependency"]);
  });

  it("the default settings (keep last 10, no age limit) are unchanged by the new rule", () => {
    const plan = planRetention(history(), noRules({ keepLast: 10 }), NOW);
    expect(plan.prune).toEqual([]);
  });
});
