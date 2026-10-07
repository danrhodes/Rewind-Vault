import { describe, expect, it } from "vitest";
import { ByteQueue, bytesEqual, concatBytes, fromBase64, toBase64 } from "../../src/helpers/bytes";

const u = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe("bytes", () => {
  it("concatBytes joins pieces", () => {
    expect(concatBytes([u(1, 2), u(), u(3)])).toEqual(u(1, 2, 3));
    expect(concatBytes([])).toEqual(u());
  });

  it("bytesEqual compares content and length", () => {
    expect(bytesEqual(u(1, 2), u(1, 2))).toBe(true);
    expect(bytesEqual(u(1, 2), u(1, 3))).toBe(false);
    expect(bytesEqual(u(1), u(1, 2))).toBe(false);
  });

  it("base64 round-trips including large and empty input", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(big))).toEqual(big);
    expect(toBase64(u(0, 255, 128))).toBe("AP+A");
    expect(fromBase64("")).toEqual(u());
  });
});

describe("ByteQueue", () => {
  it("hands out exact slices across piece boundaries", () => {
    const q = new ByteQueue();
    q.push(u(1, 2, 3));
    q.push(u());
    q.push(u(4, 5));
    q.push(u(6, 7, 8, 9));
    expect(q.length).toBe(9);
    expect(q.take(4)).toEqual(u(1, 2, 3, 4));
    expect(q.take(2)).toEqual(u(5, 6));
    expect(q.length).toBe(3);
    expect(q.takeAll()).toEqual(u(7, 8, 9));
    expect(q.length).toBe(0);
  });

  it("throws when asked for more than is queued", () => {
    const q = new ByteQueue();
    q.push(u(1));
    expect(() => q.take(2)).toThrow(RangeError);
  });

  it("does not mutate the pushed arrays", () => {
    const q = new ByteQueue();
    const piece = u(1, 2, 3, 4);
    q.push(piece);
    q.take(2);
    expect(piece).toEqual(u(1, 2, 3, 4));
  });
});
