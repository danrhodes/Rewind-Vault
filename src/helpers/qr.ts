/**
 * Minimal QR Code encoder (ISO 18004): byte mode, error correction level M, versions 1 to 16
 * (up to 450 bytes). Written here because the plugin may not add runtime dependencies. The
 * tests decode every version's output with an independent decoder (jsQR, dev dependency only).
 */

import {
  ALIGNMENT,
  BLOCKS,
  QR_MAX_BYTES,
  QR_MAX_VERSION,
  dataCodewords,
  qrCapacity,
  remainder,
} from "./qrTables";

export { QR_MAX_BYTES, QR_MAX_VERSION, qrCapacity } from "./qrTables";

export type QrMatrix = boolean[][];

// ---- Codewords ----

function dataBits(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) push(byte, 8);
  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacityBits; pad = pad === 0xec ? 0x11 : 0xec) push(pad, 8);
  return bits;
}

function interleavedCodewords(data: Uint8Array, version: number): number[] {
  const bits = dataBits(data, version);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  const spec = BLOCKS[version] as (typeof BLOCKS)[number];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let at = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const part = codewords.slice(at, at + size);
      at += size;
      blocks.push({ data: part, ec: remainder(part, spec.ec) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++)
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i] as number);
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.ec[i] as number);
  return out;
}

// ---- Matrix ----

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(version: number) {
    this.size = 17 + 4 * version;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, value: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    (this.dark[y] as boolean[])[x] = value;
    (this.fixed[y] as boolean[])[x] = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    grid.set(6, i, i % 2 === 0);
    grid.set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        grid.set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = ALIGNMENT[version] as number[];
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      const onFinder =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (onFinder) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  drawFormat(grid, 0); // reserves the format areas; rewritten once the mask is known
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      grid.set(a, b, bit);
      grid.set(b, a, bit);
    }
  }
}

/** Level M is format value 0. */
function drawFormat(grid: Grid, mask: number): void {
  const { size } = grid;
  const data = mask; // (level M = 0b00) << 3 | mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) grid.set(8, i, bit(i));
  grid.set(8, 7, bit(6));
  grid.set(8, 8, bit(7));
  grid.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) grid.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) grid.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) grid.set(8, size - 15 + i, bit(i));
  grid.set(8, size - 8, true); // the always-dark module
}

function placeData(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid;
  let bitIndex = 0;
  const next = (): boolean => {
    const word = codewords[bitIndex >>> 3];
    const value = word === undefined ? false : ((word >>> (7 - (bitIndex & 7))) & 1) === 1;
    bitIndex++;
    return value;
  };
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!(grid.fixed[y] as boolean[])[x]) (grid.dark[y] as boolean[])[x] = next();
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): void {
  const test = MASKS[mask] as (x: number, y: number) => boolean;
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!(grid.fixed[y] as boolean[])[x] && test(x, y)) {
        (grid.dark[y] as boolean[])[x] = !(grid.dark[y] as boolean[])[x];
      }
    }
  }
}

/** Penalty score of the four ISO rules (lower is easier to scan). */
function penalty(m: QrMatrix): number {
  const n = m.length;
  const at = (x: number, y: number): boolean => (m[y] as boolean[])[x] as boolean;
  let score = 0;
  for (const horizontal of [true, false]) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      let history = "";
      for (let b = 0; b < n; b++) {
        const cell = horizontal ? at(b, a) : at(a, b);
        history += cell ? "1" : "0";
        if (b > 0 && cell === (horizontal ? at(b - 1, a) : at(a, b - 1))) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
      for (const pattern of ["10111010000", "00001011101"]) {
        let from = history.indexOf(pattern);
        while (from >= 0) {
          score += 40;
          from = history.indexOf(pattern, from + 1);
        }
      }
    }
  }
  let darkCount = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (at(x, y)) darkCount++;
      if (x < n - 1 && y < n - 1) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
      }
    }
  }
  score += 10 * Math.floor(Math.abs((darkCount * 100) / (n * n) - 50) / 5);
  return score;
}

/** Encode bytes as a QR code (level M). Throws when they do not fit (QR_MAX_BYTES). */
export function encodeQr(data: Uint8Array): QrMatrix {
  let version = 1;
  while (version <= QR_MAX_VERSION && qrCapacity(version) < data.length) version++;
  if (version > QR_MAX_VERSION) {
    throw new RangeError(
      `Too much data for a QR code (${data.length} bytes, most is ${QR_MAX_BYTES})`,
    );
  }
  const codewords = interleavedCodewords(data, version);
  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = new Grid(version);
    drawFunctionPatterns(grid, version);
    placeData(grid, codewords);
    applyMask(grid, mask);
    drawFormat(grid, mask);
    const score = penalty(grid.dark);
    if (score < bestScore) {
      bestScore = score;
      best = grid.dark;
    }
  }
  return best as QrMatrix;
}
