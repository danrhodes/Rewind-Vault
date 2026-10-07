import { describe, expect, it } from "vitest";
import { planRetention } from "../../src/core/Retention";
import {
  DAY,
  NOW,
  indexOf,
  noRules,
  prunedIds,
  type EntrySpec,
} from "../support/retentionFixtures";

/** A backup made at an absolute UTC moment (month is 1-based). */
const at = (id: string, y: number, m: number, d: number, h = 0, min = 0): EntrySpec => ({
  id,
  age: NOW - Date.UTC(y, m - 1, d, h, min),
});

const gfs = (daily: number, weekly: number, monthly: number, extra = {}) =>
  noRules({ gfsEnabled: true, gfsDaily: daily, gfsWeekly: weekly, gfsMonthly: monthly, ...extra });

const keptIds = (plan: ReturnType<typeof planRetention>): string[] => [...plan.keep.keys()].sort();

describe("planRetention: GFS daily", () => {
  it("keeps the newest backup of each of the last D days", () => {
    // NOW is 2026-10-07 12:00. Four backups a day on Oct 5, 6, 7 (before noon).
    const index = indexOf(
      at("5a", 2026, 10, 5, 1),
      at("5b", 2026, 10, 5, 20),
      at("6a", 2026, 10, 6, 2),
      at("6b", 2026, 10, 6, 22),
      at("7a", 2026, 10, 7, 3),
      at("7b", 2026, 10, 7, 9),
    );
    const plan = planRetention(index, gfs(2, 0, 0), NOW);
    expect(prunedIds(plan)).toEqual(["5a", "5b", "6a", "7a"]);
    expect(plan.keep.get("6b")).toContain("gfs");
    expect(plan.keep.get("7b")).toContain("gfs");
  });

  it("counts days that HAVE backups, so a gap does not erase history", () => {
    const index = indexOf(
      at("jan", 2026, 1, 10, 8),
      at("feb", 2026, 2, 10, 8),
      at("mar", 2026, 3, 10, 8),
      at("oct", 2026, 10, 7, 8),
    );
    expect(prunedIds(planRetention(index, gfs(3, 0, 0), NOW))).toEqual(["jan"]);
  });

  it("splits days at UTC midnight", () => {
    const index = indexOf(
      at("late", 2026, 10, 5, 23, 59),
      at("early", 2026, 10, 6, 0, 0),
      at("now", 2026, 10, 7, 9),
    );
    expect(prunedIds(planRetention(index, gfs(3, 0, 0), NOW))).toEqual([]);
    expect(prunedIds(planRetention(index, gfs(2, 0, 0), NOW))).toEqual(["late"]);
  });
});

describe("planRetention: GFS weekly", () => {
  // One backup every day from 2026-09-01 to 2026-10-07 at 06:00.
  const daily = (): EntrySpec[] => {
    const specs: EntrySpec[] = [];
    for (let t = Date.UTC(2026, 8, 1, 6); t <= Date.UTC(2026, 9, 7, 6); t += DAY) {
      const d = new Date(t);
      specs.push(
        at(
          `d${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
          2026,
          d.getUTCMonth() + 1,
          d.getUTCDate(),
          6,
        ),
      );
    }
    return specs;
  };

  it("keeps the newest backup of each of the last W weeks (weeks start Monday)", () => {
    // Weeks (Mon..Sun): Oct 5-11 (newest backup Oct 7), Sep 28-Oct 4 (Oct 4), Sep 21-27 (Sep 27).
    const plan = planRetention(indexOf(...daily()), gfs(0, 3, 0), NOW);
    expect(keptIds(plan)).toEqual(["d10-4", "d10-7", "d9-27"]);
  });

  it("puts Sunday and Monday in different weeks", () => {
    const index = indexOf(
      at("sun", 2026, 10, 4, 23, 59),
      at("mon", 2026, 10, 5, 0, 0),
      at("wed", 2026, 10, 7, 9),
    );
    // weeks: [sun] | [mon, wed] -> 2 weeks, newest of the second is wed; mon is pruned.
    const plan = planRetention(index, gfs(0, 2, 0), NOW);
    expect(prunedIds(plan)).toEqual(["mon"]);
  });
});

describe("planRetention: GFS monthly", () => {
  const monthly = (): EntrySpec[] => [
    at("jul-a", 2026, 7, 2),
    at("jul-b", 2026, 7, 30),
    at("aug-a", 2026, 8, 3),
    at("aug-b", 2026, 8, 31, 23, 59),
    at("sep-a", 2026, 9, 1),
    at("sep-b", 2026, 9, 15),
    at("oct-a", 2026, 10, 1),
    at("oct-b", 2026, 10, 7, 9),
  ];

  it("keeps the newest backup of each of the last M months", () => {
    const plan = planRetention(indexOf(...monthly()), gfs(0, 0, 3), NOW);
    expect(keptIds(plan)).toEqual(["aug-b", "oct-b", "sep-b"]);
  });

  it("handles the year boundary", () => {
    const index = indexOf(
      at("dec", 2025, 12, 31, 23),
      at("jan", 2026, 1, 1, 0),
      at("jan2", 2026, 1, 20),
      at("oct", 2026, 10, 7, 9),
    );
    const plan = planRetention(index, gfs(0, 0, 4), NOW);
    expect(prunedIds(plan)).toEqual(["jan"]); // Dec, Jan (newest = jan2), Oct
  });
});

describe("planRetention: GFS combined", () => {
  const history = (): EntrySpec[] => {
    const specs: EntrySpec[] = [];
    // Twice a day for 120 days back from Oct 7.
    for (let i = 0; i < 240; i++) {
      specs.push({
        id: `h${String(i).padStart(3, "0")}`,
        age: i * 12 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000,
      });
    }
    return specs;
  };

  it("keeps the union of daily, weekly and monthly picks and prunes the rest", () => {
    const plan = planRetention(indexOf(...history()), gfs(7, 4, 3), NOW);
    const kept = plan.keep.size;
    // 7 days + weekly extras + monthly extras, far fewer than 240 but at least 7.
    expect(kept).toBeGreaterThanOrEqual(7);
    expect(kept).toBeLessThanOrEqual(7 + 4 + 3);
    expect(plan.prune.length).toBe(240 - kept);
    // The newest backup of today is always among them.
    expect(plan.keep.get("h000")).toContain("gfs");
  });

  it("a backup chosen by two granularities is listed once with one gfs reason", () => {
    const index = indexOf(at("only", 2026, 10, 7, 9));
    const plan = planRetention(index, gfs(1, 1, 1), NOW);
    expect(plan.keep.get("only")?.filter((r) => r === "gfs")).toHaveLength(1);
  });

  it("is a union with keep last and keep days", () => {
    const index = indexOf(
      at("old", 2026, 5, 1),
      at("mid", 2026, 8, 15),
      at("recent", 2026, 10, 6),
      at("newest", 2026, 10, 7, 9),
    );
    // GFS monthly 1 keeps newest; keep last 2 adds recent; keep 60 days adds mid (53 days).
    const plan = planRetention(index, gfs(0, 0, 1, { keepLast: 2, keepDays: 60 }), NOW);
    expect(prunedIds(plan)).toEqual(["old"]);
    expect(plan.keep.get("mid")).toEqual(["keep-days"]);
  });

  it("keeps chain dependencies of GFS picks", () => {
    const index = indexOf(
      { ...at("F", 2026, 9, 1), type: "full" },
      { ...at("D1", 2026, 9, 2), type: "diff", baseId: "F" },
      { ...at("D2", 2026, 10, 7, 9), type: "diff", baseId: "F" },
    );
    const plan = planRetention(index, gfs(1, 0, 0), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("D1")).toEqual(["chain-dependency"]);
  });
});

describe("planRetention: GFS switches", () => {
  const index = () => indexOf(at("a", 2026, 10, 1), at("b", 2026, 10, 7, 9));

  it("is ignored when gfsEnabled is off, whatever the counts", () => {
    const plan = planRetention(index(), noRules({ gfsEnabled: false, gfsDaily: 1 }), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("a")).toEqual(["no-policy"]);
  });

  it("with all three counts at zero it switches itself off instead of pruning everything", () => {
    expect(planRetention(index(), gfs(0, 0, 0), NOW).prune).toEqual([]);
  });

  it("never counts corrupt backups, and the newest intact is always kept", () => {
    const withBad = indexOf(at("a", 2026, 10, 1), {
      ...at("bad", 2026, 10, 7, 9),
      status: "corrupt",
    });
    const plan = planRetention(withBad, gfs(1, 0, 0), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("bad")).toEqual(["not-intact"]);
  });

  it("the default settings still behave (GFS off)", () => {
    expect(planRetention(index(), noRules({ keepLast: 5 }), NOW).prune).toEqual([]);
  });
});
