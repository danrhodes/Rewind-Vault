import { describe, expect, it } from "vitest";
import { loadManifest } from "../../src/core/Manifest";
import { readZipDirectory } from "../../src/helpers/zipDirectory";
import { pickSample, seededRandom } from "../../src/helpers/random";
import { VerificationError } from "../../src/helpers/errors";
import { rig, runOk, seedVault, verifyEngineFor, type Rig } from "../support/engineRig";

describe("seededRandom / pickSample", () => {
  it("is deterministic per seed, in [0,1), and different seeds differ", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 20 }, () => a());
    expect(seqA).toEqual(Array.from({ length: 20 }, () => b()));
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seqA).not.toEqual(
      Array.from(
        { length: 20 },
        (
          (r) => () =>
            r()
        )(seededRandom(43)),
      ),
    );
  });

  const items = Array.from({ length: 50 }, (_, i) => `f${i}.md`);

  it("picks ceil(pct%) distinct items, at least one, all for 100", () => {
    expect(pickSample(items, 10, seededRandom(1)).size).toBe(5);
    expect(pickSample(items, 1, seededRandom(1)).size).toBe(1);
    expect(pickSample(items, 33, seededRandom(1)).size).toBe(17);
    expect(pickSample(items, 100, seededRandom(1)).size).toBe(50);
    expect(pickSample([], 50, seededRandom(1)).size).toBe(0);
    expect(pickSample(["only"], 5, seededRandom(1))).toEqual(new Set(["only"]));
  });

  it("depends on the seed and the set, not on the input order", () => {
    const one = pickSample(items, 20, seededRandom(7));
    expect(pickSample([...items].reverse(), 20, seededRandom(7))).toEqual(one);
    expect(pickSample(items, 20, seededRandom(8))).not.toEqual(one);
    for (const x of one) expect(items).toContain(x);
  });

  it("every item gets picked with roughly equal frequency", () => {
    const hits = new Map<string, number>();
    for (let seed = 0; seed < 2000; seed++) {
      for (const x of pickSample(items, 10, seededRandom(seed)))
        hits.set(x, (hits.get(x) ?? 0) + 1);
    }
    for (const x of items) expect(hits.get(x) ?? 0).toBeGreaterThan(130); // expected 200
    for (const x of items) expect(hits.get(x) ?? 0).toBeLessThan(280);
  });
});

async function stored(): Promise<{ r: Rig; id: string; paths: string[]; part: string }> {
  const r = rig((p) => void (p.zip.compressionLevel = 0));
  await seedVault(r.store, 40);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  const m = await loadManifest(r.store, `backup/${backupId}`);
  return {
    r,
    id: backupId,
    paths: m.entries.map((e) => e.path),
    part: `backup/${backupId}/part-001.zip`,
  };
}

/** Damage one entry's stored bytes and fix nothing else. */
async function damage(r: Rig, part: string, name: string): Promise<void> {
  const bytes = (await r.store.readBinary(part)).slice();
  const e = readZipDirectory(bytes).find((x) => x.name === name);
  if (!e) throw new Error("no entry");
  const at = e.dataOffset + Math.floor(e.compressedSize / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  await r.store.writeBinary(part, bytes);
}

describe("verify with sampling", () => {
  it("reports what was sampled and passes a healthy backup", async () => {
    const { r, id } = await stored();
    const report = await verifyEngineFor(r).verify(id, { level: 2, sample: { pct: 10, seed: 5 } });
    expect(report.result).toBe("pass");
    expect(report.sample).toEqual({ pct: 10, entriesSampled: 4, entriesTotal: 40 });
  });

  it("is deterministic: the same seed checks the same entries", async () => {
    const { r, id, paths, part } = await stored();
    const picked = pickSample(paths, 10, seededRandom(99));
    const inside = [...picked][0] as string;
    const outside = paths.find((p) => !picked.has(p)) as string;
    const eng = verifyEngineFor(r);

    await damage(r, part, outside);
    const missed = await eng.verify(id, { level: 2, sample: { pct: 10, seed: 99 } });
    expect(missed.issues.filter((i) => i.path !== undefined)).toEqual([]); // not sampled: unseen

    await damage(r, part, inside);
    for (let i = 0; i < 3; i++) {
      const caught = await eng.verify(id, { level: 2, sample: { pct: 10, seed: 99 } });
      expect(caught.issues.find((x) => x.path !== undefined)?.path).toBe(inside);
    }
  });

  it("detects one bad entry with probability about the sample fraction", async () => {
    const { r, id, paths, part } = await stored();
    await damage(r, part, paths[17] as string);
    const eng = verifyEngineFor(r);
    let caught = 0;
    for (let seed = 0; seed < 200; seed++) {
      const rep = await eng.verify(id, { level: 2, sample: { pct: 25, seed } });
      if (rep.issues.some((i) => i.path === paths[17])) caught++;
    }
    expect(caught).toBeGreaterThan(30); // expected 50
    expect(caught).toBeLessThan(75);
  });

  it("100 percent (or no sample option) checks everything and adds no sample info", async () => {
    const { r, id, paths, part } = await stored();
    await damage(r, part, paths[3] as string);
    for (const sample of [undefined, { pct: 100 }]) {
      const rep = await verifyEngineFor(r).verify(id, { level: 2, sample });
      expect(rep.sample).toBeUndefined();
      expect(rep.issues.some((i) => i.path === paths[3])).toBe(true);
    }
  });

  it("checks at least one entry even for a tiny percentage", async () => {
    const { r, id } = await stored();
    const rep = await verifyEngineFor(r).verify(id, { level: 3, sample: { pct: 0.1, seed: 1 } });
    expect(rep.sample?.entriesSampled).toBe(1);
  });

  it("structure checks stay complete under sampling", async () => {
    const { r, id, part } = await stored();
    await r.store.remove(part);
    const rep = await verifyEngineFor(r).verify(id, { level: 2, sample: { pct: 5, seed: 1 } });
    expect(rep.result).toBe("fail");
    expect(rep.issues[0]?.message).toMatch(/missing/);
  });

  it("level 1 ignores sampling", async () => {
    const { r, id } = await stored();
    const rep = await verifyEngineFor(r).verify(id, { level: 1, sample: { pct: 10, seed: 1 } });
    expect(rep.sample).toBeUndefined();
  });

  it("without a seed it still works (clock-based) and is repeatable at one instant", async () => {
    const { r, id } = await stored();
    const a = await verifyEngineFor(r).verify(id, { level: 2, sample: { pct: 10 } });
    const b = await verifyEngineFor(r).verify(id, { level: 2, sample: { pct: 10 } });
    expect(a.sample).toEqual(b.sample);
  });

  it("rejects nonsense percentages", async () => {
    const { r, id } = await stored();
    for (const pct of [0, -5, 101, Number.NaN]) {
      await expect(verifyEngineFor(r).verify(id, { level: 2, sample: { pct } })).rejects.toThrow(
        VerificationError,
      );
    }
  });

  it("applies to the dependencies of a chain check too", async () => {
    const r = rig((p) => void (p.zip.compressionLevel = 0));
    await seedVault(r.store, 20);
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(5000);
    await r.store.seed("extra.md", "x");
    const diff = await runOk(r.engine, { mode: "diff" });
    const rep = await verifyEngineFor(r).verify(diff.backupId, {
      level: 5,
      sample: { pct: 10, seed: 3 },
    });
    expect(rep.result).toBe("pass");
    expect(rep.sample).toBeDefined();
  });
});
