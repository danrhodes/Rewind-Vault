import { VerificationError } from "./errors";

/** One entry of a ZIP file, as recorded in its central directory. */
export interface ZipDirectoryEntry {
  name: string;
  /** CRC-32 of the uncompressed data, as stored by the writer. */
  crc32: number;
  compressedSize: number;
  size: number;
  /** 0 = stored, 8 = deflate. */
  method: number;
  /** Offset of the entry's local header. */
  localOffset: number;
  /** Offset of the entry's compressed data. */
  dataOffset: number;
}

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
const CEN_SIG = 0x02014b50;
const CEN_FIXED = 46;
const LOC_SIG = 0x04034b50;
const LOC_FIXED = 30;
const MAX_COMMENT = 0xffff;
const ZIP64_MARK = 0xffffffff;

/**
 * Read a ZIP file's central directory without decompressing anything, and check that it is
 * internally consistent: the end record is found, the directory lies inside the file, every
 * header is well formed, and every entry's local header and data are where the directory says.
 * Throws VerificationError describing the first problem found.
 */
export function readZipDirectory(data: Uint8Array): ZipDirectoryEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fail = (message: string): never => {
    throw new VerificationError(message);
  };

  const eocd = findEndRecord(view);
  if (eocd < 0) return fail("ZIP end-of-directory record not found (file truncated or damaged)");
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === ZIP64_MARK || cdOffset === ZIP64_MARK) {
    return fail("ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > eocd) return fail("ZIP central directory lies outside the file");

  const decoder = new TextDecoder("utf-8");
  const entries: ZipDirectoryEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < total; i++) {
    if (pos + CEN_FIXED > cdOffset + cdSize || view.getUint32(pos, true) !== CEN_SIG) {
      return fail(`ZIP central directory entry ${i + 1} is damaged`);
    }
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const next = pos + CEN_FIXED + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) return fail(`ZIP central directory entry ${i + 1} overruns`);
    const entry: ZipDirectoryEntry = {
      name: decoder.decode(data.subarray(pos + CEN_FIXED, pos + CEN_FIXED + nameLen)),
      crc32: view.getUint32(pos + 16, true),
      compressedSize: view.getUint32(pos + 20, true),
      size: view.getUint32(pos + 24, true),
      method: view.getUint16(pos + 10, true),
      localOffset: view.getUint32(pos + 42, true),
      dataOffset: 0,
    };
    if (entry.compressedSize === ZIP64_MARK || entry.size === ZIP64_MARK) {
      return fail(`ZIP entry "${entry.name}" uses ZIP64, which is not supported`);
    }
    entry.dataOffset = checkLocalHeader(view, data, entry, cdOffset, fail);
    entries.push(entry);
    pos = next;
  }
  if (pos !== cdOffset + cdSize) return fail("ZIP central directory has unexpected extra bytes");
  return entries;
}

/** Position of the end-of-central-directory record, or -1. */
function findEndRecord(view: DataView): number {
  const last = view.byteLength - EOCD_MIN;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let pos = last; pos >= first; pos--) {
    if (view.getUint32(pos, true) !== EOCD_SIG) continue;
    if (pos + EOCD_MIN + view.getUint16(pos + 20, true) === view.byteLength) return pos;
  }
  return -1;
}

function checkLocalHeader(
  view: DataView,
  data: Uint8Array,
  entry: ZipDirectoryEntry,
  cdOffset: number,
  fail: (message: string) => never,
): number {
  const at = entry.localOffset;
  if (at + LOC_FIXED > cdOffset || view.getUint32(at, true) !== LOC_SIG) {
    return fail(`ZIP entry "${entry.name}": local header missing at its recorded position`);
  }
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const dataOffset = at + LOC_FIXED + nameLen + extraLen;
  const localName = new TextDecoder("utf-8").decode(
    data.subarray(at + LOC_FIXED, at + LOC_FIXED + nameLen),
  );
  if (localName !== entry.name) {
    return fail(`ZIP entry "${entry.name}": local header names "${localName}" instead`);
  }
  if (dataOffset + entry.compressedSize > cdOffset) {
    return fail(`ZIP entry "${entry.name}": data runs past the end of the archive`);
  }
  return dataOffset;
}
