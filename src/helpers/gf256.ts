/** Arithmetic in GF(256) with the polynomial 0x11D (the field used by QR codes and Reed-Solomon). */

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

export const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

export function gfInv(a: number): number {
  if (a === 0) throw new RangeError("0 has no inverse in GF(256)");
  return EXP[255 - (LOG[a] as number)] as number;
}

const TABLES = new Map<number, Uint8Array>();

/** `table[x] = c * x` for every byte x, for fast multiplication of whole blocks by a constant. */
export function mulTable(c: number): Uint8Array {
  let table = TABLES.get(c);
  if (!table) {
    table = new Uint8Array(256);
    for (let x = 0; x < 256; x++) table[x] = gfMul(c, x);
    TABLES.set(c, table);
  }
  return table;
}

/** `target ^= c * source`, byte by byte. */
export function addScaled(target: Uint8Array, source: Uint8Array, c: number): void {
  if (c === 0) return;
  const table = mulTable(c);
  for (let i = 0; i < target.length; i++) {
    target[i] = (target[i] as number) ^ (table[source[i] as number] as number);
  }
}

/**
 * Invert a square matrix over GF(256) (Gauss-Jordan). Returns null if it is singular.
 * Rows are plain number arrays; the input is not modified.
 */
export function invertMatrix(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && (a[pivot] as number[])[col] === 0) pivot++;
    if (pivot === n) return null;
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
    const row = a[col] as number[];
    const scale = gfInv(row[col] as number);
    for (let j = 0; j < 2 * n; j++) row[j] = gfMul(row[j] as number, scale);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const other = a[r] as number[];
      const factor = other[col] as number;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        other[j] = (other[j] as number) ^ gfMul(factor, row[j] as number);
      }
    }
  }
  return a.map((row) => row.slice(n));
}
