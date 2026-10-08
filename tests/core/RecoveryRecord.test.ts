import { describe, expect, it } from "vitest";
import {
  buildRecord,
  parseRecord,
  planRecord,
  repairWithRecord,
} from "../../src/core/RecoveryRecord";
import { addScaled, gfInv, gfMul, invertMatrix } from "../../src/helpers/gf256";

const KB = 1024;

function sample(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** Fast equality for big buffers (toEqual compares element by element and is far too slow). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const damage = (data: Uint8Array, at: number, length = 1): Uint8Array => {
  const copy = data.slice();
  for (let i = 0; i < length; i++) copy[at + i] = (copy[at + i] as number) ^ 0xa5;
  return copy;
};

describe("GF(256)", () => {
  it("multiplies and inverts", () => {
    expect(gfMul(0, 77)).toBe(0);
    expect(gfMul(1, 77)).toBe(77);
    expect(gfMul(2, 128)).toBe(0x1d); // x * x^7 wraps through the field polynomial
    for (const a of [1, 2, 3, 29, 100, 255]) expect(gfMul(a, gfInv(a))).toBe(1);
    expect(() => gfInv(0)).toThrow(RangeError);
  });

  it("addScaled adds a multiple of one block to another", () => {
    const target = Uint8Array.from([1, 2, 3]);
    addScaled(target, Uint8Array.from([4, 5, 6]), 1);
    expect([...target]).toEqual([5, 7, 5]);
    addScaled(target, Uint8Array.from([9, 9, 9]), 0);
    expect([...target]).toEqual([5, 7, 5]);
  });

  it("inverts a matrix and rejects a singular one", () => {
    const m = [
      [1, 2],
      [3, 7],
    ];
    const inv = invertMatrix(m) as number[][];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const cell =
          gfMul((m[i] as number[])[0] as number, (inv[0] as number[])[j] as number) ^
          gfMul((m[i] as number[])[1] as number, (inv[1] as number[])[j] as number);
        expect(cell).toBe(i === j ? 1 : 0);
      }
    }
    expect(
      invertMatrix([
        [1, 1],
        [1, 1],
      ]),
    ).toBeNull();
  });
});

describe("planRecord", () => {
  it("returns nothing when off or empty", () => {
    expect(planRecord(1000, 0)).toBeNull();
    expect(planRecord(0, 10)).toBeNull();
  });

  it("uses 64 KB blocks for small files and at most 200 data blocks for big ones", () => {
    expect(planRecord(100 * KB, 10)).toEqual({ blockSize: 64 * KB, k: 2, m: 1 });
    const big = planRecord(100 * 1024 * KB, 5);
    expect(big?.k).toBeLessThanOrEqual(200);
    expect(big?.m).toBe(Math.ceil(((big?.k ?? 0) * 5) / 100));
  });

  it("caps the percentage and keeps data plus parity within 256 blocks", () => {
    const p = planRecord(1000 * 1024 * KB, 90);
    expect((p?.k ?? 0) + (p?.m ?? 0)).toBeLessThanOrEqual(256);
    expect(p?.m).toBe(56); // 200 data blocks leave room for 56 parity blocks
  });
});

describe("recovery record", () => {
  it("leaves an undamaged file alone", async () => {
    const data = sample(300 * KB);
    const record = (await buildRecord(data, 40)) as Uint8Array;
    expect(repairWithRecord(data, record)).toEqual({ status: "intact" });
  });

  it("returns null for percent 0 and for an empty file", async () => {
    expect(await buildRecord(sample(100), 0)).toBeNull();
    expect(await buildRecord(new Uint8Array(0), 10)).toBeNull();
  });

  it("repairs one flipped byte", async () => {
    const data = sample(300 * KB);
    const record = (await buildRecord(data, 40)) as Uint8Array;
    const result = repairWithRecord(damage(data, 100 * KB + 7), record);
    expect(result.status).toBe("repaired");
    if (result.status === "repaired") {
      expect(sameBytes(result.data, data)).toBe(true);
      expect(result.blocks).toEqual([1]);
    }
  });

  it("repairs as many damaged blocks as there are parity blocks, anywhere", async () => {
    const data = sample(300 * KB, 9); // 5 blocks, 40% -> 2 parity blocks
    const record = (await buildRecord(data, 40)) as Uint8Array;
    expect(parseRecord(record)?.header).toMatchObject({ k: 5, m: 2 });
    for (const [a, b] of [
      [0, 1],
      [0, 4],
      [2, 3],
      [3, 4],
    ] as const) {
      const bad = damage(damage(data, a * 64 * KB, 50), b * 64 * KB + 100, 200);
      const result = repairWithRecord(bad, record);
      expect(result.status, `${a},${b}`).toBe("repaired");
      if (result.status === "repaired") expect(sameBytes(result.data, data)).toBe(true);
    }
  });

  it("gives up when more blocks are damaged than the record can rebuild", async () => {
    const data = sample(300 * KB);
    const record = (await buildRecord(data, 40)) as Uint8Array;
    const bad = damage(damage(damage(data, 0), 64 * KB), 128 * KB);
    const result = repairWithRecord(bad, record);
    expect(result.status).toBe("unrecoverable");
  });

  it("repairs a truncated file, a file with junk appended, and a missing small file", async () => {
    const data = sample(200 * KB, 3); // 4 blocks, 50% -> 2 parity blocks
    const record = (await buildRecord(data, 50)) as Uint8Array;
    const truncated = repairWithRecord(data.slice(0, 150 * KB), record);
    expect(truncated.status).toBe("repaired");
    if (truncated.status === "repaired") expect(sameBytes(truncated.data, data)).toBe(true);

    const extended = new Uint8Array(data.length + 5000);
    extended.set(data);
    extended.fill(7, data.length);
    const trimmed = repairWithRecord(extended, record);
    expect(trimmed.status).toBe("repaired");
    if (trimmed.status === "repaired") expect(sameBytes(trimmed.data, data)).toBe(true);

    const tiny = sample(10 * KB, 5);
    const tinyRecord = (await buildRecord(tiny, 10)) as Uint8Array;
    const gone = repairWithRecord(null, tinyRecord);
    expect(gone.status).toBe("repaired");
    if (gone.status === "repaired") expect(sameBytes(gone.data, tiny)).toBe(true);
  });

  it("does not trust a damaged parity block: it is skipped and another one is used", async () => {
    const data = sample(300 * KB, 11);
    const record = (await buildRecord(data, 40)) as Uint8Array; // k=5, m=2
    const parsed = parseRecord(record);
    const brokenRecord = damage(record, (parsed?.parityAt ?? 0) + 10); // first parity block
    const result = repairWithRecord(damage(data, 0), brokenRecord);
    expect(result.status).toBe("repaired");
    if (result.status === "repaired") expect(sameBytes(result.data, data)).toBe(true);
    // Two damaged data blocks and one damaged parity block: not enough left.
    const two = repairWithRecord(damage(damage(data, 0), 64 * KB), brokenRecord);
    expect(two.status).toBe("unrecoverable");
  });

  it("refuses a record whose header is damaged or truncated", async () => {
    const data = sample(100 * KB);
    const record = (await buildRecord(data, 20)) as Uint8Array;
    expect(repairWithRecord(data, damage(record, 20)).status).toBe("unrecoverable");
    expect(repairWithRecord(data, record.slice(0, 30)).status).toBe("unrecoverable");
    expect(repairWithRecord(data, new Uint8Array(5)).status).toBe("unrecoverable");
    expect(parseRecord(record.slice(0, record.length - 1))).toBeNull();
  });

  it("repairs five damaged blocks of a 100-block file protected at 10 percent", async () => {
    const data = sample(100 * 64 * KB, 21);
    const record = (await buildRecord(data, 10)) as Uint8Array;
    expect(parseRecord(record)?.header).toMatchObject({ k: 100, m: 10 });
    let bad = data;
    for (const block of [3, 40, 41, 70, 99]) bad = damage(bad, block * 64 * KB + 5, 1000);
    const result = repairWithRecord(bad, record);
    expect(result.status).toBe("repaired");
    if (result.status === "repaired") {
      expect(result.blocks).toEqual([3, 40, 41, 70, 99]);
      expect(sameBytes(result.data, data)).toBe(true);
    }
  });

  it("awaits the yield callback while encoding", async () => {
    let yields = 0;
    await buildRecord(sample(130 * KB), 50, async () => {
      yields++;
    });
    expect(yields).toBeGreaterThan(0);
  });
});
