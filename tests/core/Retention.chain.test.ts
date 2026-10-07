import { describe, expect, it } from "vitest";
import { chainFor, loadIndex } from "../../src/core/BackupIndex";
import { planRetention } from "../../src/core/Retention";
import { seededRandom } from "../../src/helpers/random";
import type { BackupIndex } from "../../src/types";
import { idsOf, reconstruct } from "../support/chain";
import { enc, rig, runOk, type Rig } from "../support/engineRig";
import {
  DAY,
  NOW,
  indexOf,
  noRules,
  prunedIds,
  type EntrySpec,
} from "../support/retentionFixtures";

/** F1 <- D1 <- D2 <- D3, then F2 <- D4, oldest first. */
const twoChains = (): EntrySpec[] => [
  { id: "F1", age: 6 * DAY },
  { id: "D1", age: 5 * DAY, type: "diff", baseId: "F1" },
  { id: "D2", age: 4 * DAY, type: "diff", baseId: "F1" },
  { id: "D3", age: 3 * DAY, type: "diff", baseId: "F1" },
  { id: "F2", age: 2 * DAY },
  { id: "D4", age: DAY, type: "diff", baseId: "F2" },
];

describe("chain safety: never prune a base (or earlier diff) with live dependents", () => {
  it("keep last 1 on a diff keeps its whole chain, so nothing in it is pruned", () => {
    const index = indexOf(
      { id: "F1", age: 4 * DAY },
      { id: "D1", age: 3 * DAY, type: "diff", baseId: "F1" },
      { id: "D2", age: 2 * DAY, type: "diff", baseId: "F1" },
      { id: "D3", age: DAY, type: "diff", baseId: "F1" },
    );
    const plan = planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("D3")).toContain("keep-last");
    expect(plan.keep.get("F1")).toEqual(["chain-dependency"]);
    expect(plan.keep.get("D1")).toEqual(["chain-dependency"]);
    expect(plan.keep.get("D2")).toEqual(["chain-dependency"]);
  });

  it("prunes a whole older chain once a newer full makes it unreferenced", () => {
    const plan = planRetention(indexOf(...twoChains()), noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["D1", "D2", "D3", "F1"]);
  });

  it("keeps the older chain while any kept backup still depends on it", () => {
    // keep last 3 = D4, F2, D3 -> D3 pulls in F1, D1, D2.
    const plan = planRetention(indexOf(...twoChains()), noRules({ keepLast: 3 }), NOW);
    expect(plan.prune).toEqual([]);
  });

  it("a kept middle diff keeps the base and the diffs before it, but not the diffs after it", () => {
    const index = indexOf(
      { id: "F1", age: 5 * DAY },
      { id: "D1", age: 4 * DAY, type: "diff", baseId: "F1", pinned: false },
      { id: "D2", age: 3 * DAY, type: "diff", baseId: "F1", pinned: true },
      { id: "D3", age: 2 * DAY, type: "diff", baseId: "F1" },
      { id: "F2", age: DAY },
    );
    const plan = planRetention(index, noRules({ keepLast: 1, pinnedExempt: true }), NOW);
    expect(prunedIds(plan)).toEqual(["D3"]); // D3 depends on others, nothing depends on D3
    expect(plan.keep.get("F1")).toEqual(["chain-dependency"]);
    expect(plan.keep.get("D1")).toEqual(["chain-dependency"]);
  });

  it("a pinned base survives even when everything built on it is pruned", () => {
    const index = indexOf(
      { id: "F1", age: 5 * DAY, pinned: true },
      { id: "D1", age: 4 * DAY, type: "diff", baseId: "F1" },
      { id: "F2", age: DAY },
    );
    const plan = planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["D1"]);
  });

  it("a diff of a pinned base may be pruned: the base is the only thing a milestone needs", () => {
    const index = indexOf(
      { id: "F1", age: 5 * DAY, pinned: true },
      { id: "D1", age: 4 * DAY, type: "diff", baseId: "F1" },
      { id: "D2", age: 3 * DAY, type: "diff", baseId: "F1" },
      { id: "F2", age: DAY },
    );
    expect(prunedIds(planRetention(index, noRules({ keepLast: 1 }), NOW))).toEqual(["D1", "D2"]);
  });

  it("a corrupt link inside a kept chain is left alone like any corrupt backup", () => {
    const index = indexOf(
      { id: "F1", age: 4 * DAY },
      { id: "D1", age: 3 * DAY, type: "diff", baseId: "F1", status: "corrupt" },
      { id: "D2", age: 2 * DAY, type: "diff", baseId: "F1" },
    );
    const plan = planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(plan.prune).toEqual([]);
    expect(plan.keep.get("D1")).toContain("not-intact");
  });

  it("an orphan diff (base missing from the index) does not crash the planner", () => {
    const index = indexOf(
      { id: "D1", age: 3 * DAY, type: "diff", baseId: "GONE" },
      { id: "F2", age: 2 * DAY },
      { id: "D2", age: DAY, type: "diff", baseId: "F2" },
    );
    const plan = planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(prunedIds(plan)).toEqual(["D1"]);
  });

  it("keeping an old full does not keep diffs that come after it in time", () => {
    const index = indexOf(
      { id: "F1", age: 3 * DAY, pinned: true },
      { id: "D1", age: 2 * DAY, type: "diff", baseId: "F1" },
      { id: "D2", age: DAY, type: "diff", baseId: "F1" },
    );
    const plan = planRetention(index, noRules({ keepLast: 1 }), NOW);
    expect(plan.prune).toEqual([]); // D2 needs D1 and F1
  });
});

describe("chain safety: property test over random histories", () => {
  function randomIndex(seed: number): BackupIndex {
    const rand = seededRandom(seed);
    const specs: EntrySpec[] = [];
    let base: string | null = null;
    const count = 3 + Math.floor(rand() * 14);
    for (let i = 0; i < count; i++) {
      const id = `b${String(i).padStart(2, "0")}`;
      const age = (count - i) * DAY;
      const roll = rand();
      const status = roll < 0.12 ? "corrupt" : roll < 0.16 ? "partial" : "ok";
      const pinned = rand() < 0.1;
      if (base === null || rand() < 0.2) {
        specs.push({ id, age, status, pinned });
        base = id;
      } else {
        specs.push({ id, age, type: "diff", baseId: base, status, pinned });
      }
    }
    return indexOf(...specs);
  }

  it("after pruning, every surviving backup still has its whole chain, and a good backup remains", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const index = randomIndex(seed);
      const settings = noRules({
        keepLast: 1 + (seed % 6),
        pinnedExempt: seed % 3 !== 0,
      });
      const plan = planRetention(index, settings, NOW);
      const gone = new Set(plan.prune.map((b) => b.id));
      const after: BackupIndex = {
        ...index,
        backups: index.backups.filter((b) => !gone.has(b.id)),
      };

      for (const survivor of after.backups) {
        const original = chainFor(index, survivor.id);
        const now = chainFor(after, survivor.id);
        expect(now, `seed ${seed}: chain of ${survivor.id}`).toEqual(original);
      }
      const hadIntact = index.backups.some((b) => b.status === "ok");
      if (hadIntact) {
        expect(
          after.backups.some((b) => b.status === "ok"),
          `seed ${seed}`,
        ).toBe(true);
      }
      expect(
        plan.prune.every((b) => b.status === "ok"),
        `seed ${seed}`,
      ).toBe(true);
    }
  });
});

describe("chain safety: real differential history through the engine", () => {
  async function step(r: Rig, mode: "full" | "diff"): Promise<string> {
    r.clock.advance(60_000);
    await r.store.writeBinary("a.md", enc(`a at ${r.clock.now()}`));
    await r.store.writeBinary(`n${r.clock.now()}.md`, enc("new"));
    return (await runOk(r.engine, { mode })).backupId;
  }

  async function chainRig(keepLast: number): Promise<Rig> {
    const r = rig((p) => {
      p.retention.keepLast = keepLast;
    });
    await r.store.seed("a.md", "a");
    return r;
  }

  it("keep last 2 over one long chain prunes nothing and the newest still restores exactly", async () => {
    const r = await chainRig(2);
    const ids = [await step(r, "full")];
    for (let i = 0; i < 5; i++) ids.push(await step(r, "diff"));

    const index = await loadIndex(r.store, "backup");
    expect(idsOf(index)).toEqual(ids);
    const restored = await reconstruct(r.store, "backup", ids);
    for (const path of (await r.store.list("")).files.filter((f) => f.endsWith(".md"))) {
      expect(restored.get(path), path).toEqual(await r.store.readBinary(path));
    }
  });

  it("a new full backup lets the old chain go, and what remains restores exactly", async () => {
    const r = await chainRig(2);
    const old = [await step(r, "full")];
    for (let i = 0; i < 3; i++) old.push(await step(r, "diff"));
    const f2 = await step(r, "full"); // keep 2 = F2 + D3 (still pulls the old chain)
    expect(idsOf(await loadIndex(r.store, "backup"))).toEqual([...old, f2]);

    const d5 = await step(r, "diff"); // keep 2 = D5, F2 -> the old chain is unreferenced
    const index = await loadIndex(r.store, "backup");
    expect(idsOf(index)).toEqual([f2, d5]);
    expect((await r.store.list("backup")).folders).toHaveLength(2);

    const restored = await reconstruct(r.store, "backup", [f2, d5]);
    expect(restored.get("a.md")).toEqual(await r.store.readBinary("a.md"));
  });
});
