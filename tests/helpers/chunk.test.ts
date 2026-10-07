import { describe, expect, it } from "vitest";
import { chunk, chunkBytes, iterateBytes } from "../../src/helpers/chunk";
import { createYielder, yieldToUI } from "../../src/helpers/yieldToUI";

describe("chunk", () => {
  it("splits with a short final group", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("handles empty input and exact multiples", () => {
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunk([1], 10)).toEqual([[1]]);
  });
  it("rejects bad sizes", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
    expect(() => chunkBytes(new Uint8Array(1), -1)).toThrow(RangeError);
  });
});

describe("chunkBytes", () => {
  it("returns views that reassemble to the original", () => {
    const data = Uint8Array.from({ length: 10 }, (_, i) => i);
    const parts = chunkBytes(data, 4);
    expect(parts.map((p) => p.length)).toEqual([4, 4, 2]);
    expect(parts[0]!.buffer).toBe(data.buffer);
    expect(Uint8Array.from(parts.flatMap((p) => [...p]))).toEqual(data);
  });
  it("yields nothing for empty data and is lazy", () => {
    expect(chunkBytes(new Uint8Array(0), 4)).toEqual([]);
    const it = iterateBytes(new Uint8Array(8), 4);
    expect(it.next().value).toHaveLength(4);
  });
});

describe("yieldToUI", () => {
  it("returns control so already-queued tasks run first", async () => {
    let ran = false;
    setTimeout(() => (ran = true), 0);
    await yieldToUI();
    expect(ran).toBe(true);
  });
});

describe("createYielder", () => {
  it("yields only after the time budget elapses", async () => {
    let t = 0;
    let yields = 0;
    const tick = createYielder(
      50,
      () => t,
      async () => void yields++,
    );
    t = 10;
    await tick();
    expect(yields).toBe(0);
    t = 50;
    await tick();
    expect(yields).toBe(1);
    t = 60;
    await tick();
    expect(yields).toBe(1);
    t = 100;
    await tick();
    expect(yields).toBe(2);
  });
});
