/** QR tables and Reed-Solomon arithmetic used by qr.ts. */

/** Per version (index 1..16): EC codewords per block, then [blocks, data codewords] groups. */
export const BLOCKS: Record<number, { ec: number; groups: [number, number][] }> = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: {
    ec: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
  },
  9: {
    ec: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
  },
  10: {
    ec: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
  },
  11: {
    ec: 30,
    groups: [
      [1, 50],
      [4, 51],
    ],
  },
  12: {
    ec: 22,
    groups: [
      [6, 36],
      [2, 37],
    ],
  },
  13: {
    ec: 22,
    groups: [
      [8, 37],
      [1, 38],
    ],
  },
  14: {
    ec: 24,
    groups: [
      [4, 40],
      [5, 41],
    ],
  },
  15: {
    ec: 24,
    groups: [
      [5, 41],
      [5, 42],
    ],
  },
  16: {
    ec: 28,
    groups: [
      [7, 45],
      [3, 46],
    ],
  },
};

export const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
};

export const QR_MAX_VERSION = 16;

export const dataCodewords = (version: number): number =>
  (BLOCKS[version]?.groups ?? []).reduce((n, [blocks, size]) => n + blocks * size, 0);

/** Most bytes that fit in a version at level M. */
export function qrCapacity(version: number): number {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

export const QR_MAX_BYTES = qrCapacity(QR_MAX_VERSION);

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((coef, j) => {
      next[j] = (next[j] as number) ^ coef;
      next[j + 1] = (next[j + 1] as number) ^ mul(coef, EXP[i] as number);
    });
    poly = next;
  }
  return poly;
}

export function remainder(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const rest = [...data, ...new Array<number>(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = rest[i] as number;
    if (factor === 0) continue;
    gen.forEach((g, j) => {
      rest[i + j] = (rest[i + j] as number) ^ mul(g, factor);
    });
  }
  return rest.slice(data.length);
}
