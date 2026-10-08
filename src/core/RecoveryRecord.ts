import { crc32 } from "../helpers/crc32";
import { addScaled, gfInv, invertMatrix } from "../helpers/gf256";

/**
 * Recovery records: extra data stored next to a backup part (`part-001.zip.rr`) so a part
 * that was damaged on disk, in a sync or on a flaky card can be rebuilt byte for byte.
 *
 * The part is cut into `k` blocks of `blockSize` bytes (the last one padded with zeros) and
 * `m` parity blocks are computed with an erasure code over GF(256) (a Cauchy matrix, the same
 * idea as PAR2): any `m` damaged blocks can be rebuilt from the rest. Which blocks are damaged
 * is found with a CRC-32 per block, kept in the header. Parity blocks have their own CRCs, so
 * a damaged record is never trusted. Layout: "RVRR1\n", u32 header length, u32 header CRC,
 * header JSON, then the parity blocks.
 */

/** Added to a part file name to get its recovery record: `part-001.zip.rr`. */
export const RECOVERY_SUFFIX = ".rr";

const MAGIC = new TextEncoder().encode("RVRR1\n");
const MIN_BLOCK = 64 * 1024;
/** Most data blocks per record; data blocks plus parity blocks must stay within the 256 field elements. */
const MAX_DATA_BLOCKS = 200;
export const MAX_RECOVERY_PERCENT = 50;

export interface RecordHeader {
  v: 1;
  blockSize: number;
  fileSize: number;
  /** Data blocks. */
  k: number;
  /** Parity blocks. */
  m: number;
  crc: number[];
  pcrc: number[];
}

/** Block geometry for a file, or null when no record is wanted. */
export function planRecord(
  fileSize: number,
  percent: number,
): { blockSize: number; k: number; m: number } | null {
  if (fileSize <= 0 || percent <= 0) return null;
  const blockSize = Math.max(MIN_BLOCK, Math.ceil(fileSize / MAX_DATA_BLOCKS));
  const k = Math.ceil(fileSize / blockSize);
  const wanted = Math.ceil((k * Math.min(percent, MAX_RECOVERY_PERCENT)) / 100);
  const m = Math.max(1, Math.min(wanted, 256 - k));
  return { blockSize, k, m };
}

/** Matrix entry for parity row j and data column i: 1 / (x_j + y_i), all x and y distinct. */
const coefficient = (j: number, i: number, m: number): number => gfInv(j ^ (m + i));

function blocksOf(data: Uint8Array, blockSize: number, k: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < k; i++) {
    const block = new Uint8Array(blockSize);
    block.set(data.subarray(i * blockSize, Math.min(data.length, (i + 1) * blockSize)));
    out.push(block);
  }
  return out;
}

/**
 * Build the record for `data`, or null when `percent` is 0 or the file is empty. `yieldIfNeeded`
 * is awaited between blocks so the app stays responsive on a phone.
 */
export async function buildRecord(
  data: Uint8Array,
  percent: number,
  yieldIfNeeded: () => Promise<void> = async () => undefined,
): Promise<Uint8Array | null> {
  const plan = planRecord(data.length, percent);
  if (!plan) return null;
  const { blockSize, k, m } = plan;
  const blocks = blocksOf(data, blockSize, k);
  const parity: Uint8Array[] = [];
  for (let j = 0; j < m; j++) {
    const p = new Uint8Array(blockSize);
    for (let i = 0; i < k; i++) {
      addScaled(p, blocks[i] as Uint8Array, coefficient(j, i, m));
      await yieldIfNeeded();
    }
    parity.push(p);
  }
  const header: RecordHeader = {
    v: 1,
    blockSize,
    fileSize: data.length,
    k,
    m,
    crc: blocks.map(crc32),
    pcrc: parity.map(crc32),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(MAGIC.length + 8 + json.length + m * blockSize);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(MAGIC.length, json.length, true);
  view.setUint32(MAGIC.length + 4, crc32(json), true);
  out.set(json, MAGIC.length + 8);
  parity.forEach((p, j) => out.set(p, MAGIC.length + 8 + json.length + j * blockSize));
  return out;
}

/** The record's header and where its parity blocks start, or null if the record is damaged. */
export function parseRecord(record: Uint8Array): { header: RecordHeader; parityAt: number } | null {
  if (record.length < MAGIC.length + 8) return null;
  for (let i = 0; i < MAGIC.length; i++) if (record[i] !== MAGIC[i]) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const length = view.getUint32(MAGIC.length, true);
  const start = MAGIC.length + 8;
  if (start + length > record.length) return null;
  const json = record.subarray(start, start + length);
  if (crc32(json) !== view.getUint32(MAGIC.length + 4, true)) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(json)) as RecordHeader;
    const sane =
      h.v === 1 &&
      Number.isInteger(h.blockSize) &&
      h.blockSize > 0 &&
      Number.isInteger(h.k) &&
      h.k > 0 &&
      Number.isInteger(h.m) &&
      h.m > 0 &&
      h.k + h.m <= 256 &&
      h.crc.length === h.k &&
      h.pcrc.length === h.m &&
      h.fileSize > (h.k - 1) * h.blockSize &&
      h.fileSize <= h.k * h.blockSize &&
      record.length === start + length + h.m * h.blockSize;
    return sane ? { header: h, parityAt: start + length } : null;
  } catch {
    return null;
  }
}

export type RepairOutcome =
  | { status: "intact" }
  | { status: "repaired"; data: Uint8Array; blocks: number[] }
  | { status: "unrecoverable"; reason: string };

/**
 * Check `data` against its record and rebuild damaged blocks. `data` may be missing, shorter
 * (truncated) or longer than the original; missing bytes count as damaged. Pure: the caller
 * decides whether to write the result and checks it against the manifest hash.
 */
export function repairWithRecord(data: Uint8Array | null, record: Uint8Array): RepairOutcome {
  const parsed = parseRecord(record);
  if (!parsed) return { status: "unrecoverable", reason: "The recovery record is damaged" };
  const { header, parityAt } = parsed;
  const { blockSize, k, m, fileSize } = header;
  const blocks = blocksOf(data ?? new Uint8Array(0), blockSize, k);
  // Bytes beyond the original size are not part of any block.
  const bad: number[] = [];
  blocks.forEach((block, i) => {
    if (crc32(block) !== header.crc[i]) bad.push(i);
  });
  if (bad.length === 0 && data !== null && data.length === fileSize) return { status: "intact" };
  if (bad.length === 0) {
    return { status: "repaired", data: concat(blocks, fileSize), blocks: [] };
  }

  const parity: (Uint8Array | null)[] = [];
  for (let j = 0; j < m; j++) {
    const p = record.subarray(parityAt + j * blockSize, parityAt + (j + 1) * blockSize);
    parity.push(crc32(p) === header.pcrc[j] ? p : null);
  }
  const usable = parity.flatMap((p, j) => (p ? [j] : [])).slice(0, bad.length);
  if (usable.length < bad.length) {
    return {
      status: "unrecoverable",
      reason: `${bad.length} damaged block(s), but the record can rebuild at most ${parity.filter(Boolean).length}`,
    };
  }

  const matrix = usable.map((j) => bad.map((i) => coefficient(j, i, m)));
  const inverse = invertMatrix(matrix);
  if (!inverse) return { status: "unrecoverable", reason: "The recovery matrix is singular" };

  const damaged = new Set(bad);
  const syndromes = usable.map((j) => {
    const s = new Uint8Array(blockSize);
    s.set(parity[j] as Uint8Array);
    blocks.forEach((block, i) => {
      if (!damaged.has(i)) addScaled(s, block, coefficient(j, i, m));
    });
    return s;
  });
  bad.forEach((blockIndex, c) => {
    const rebuilt = new Uint8Array(blockSize);
    syndromes.forEach((s, r) => addScaled(rebuilt, s, (inverse[c] as number[])[r] as number));
    blocks[blockIndex] = rebuilt;
  });
  const stillBad = bad.filter((i) => crc32(blocks[i] as Uint8Array) !== header.crc[i]);
  if (stillBad.length > 0) {
    return { status: "unrecoverable", reason: "The rebuilt blocks do not match their checksums" };
  }
  return { status: "repaired", data: concat(blocks, fileSize), blocks: bad };
}

function concat(blocks: readonly Uint8Array[], fileSize: number): Uint8Array {
  const out = new Uint8Array(blocks.length * (blocks[0]?.length ?? 0));
  blocks.forEach((b, i) => out.set(b, i * b.length));
  return out.slice(0, fileSize);
}
