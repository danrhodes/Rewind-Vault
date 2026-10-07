import { PART_NAME_EXT, PART_NAME_PREFIX } from "../constants";
import type { FileInfo, ZipSettings } from "../types";

const MB = 1024 * 1024;

export interface SplitLimits {
  /** 0 means no limit. */
  maxFilesPerPart: number;
  maxSourceBytesPerPart: number;
  /**
   * Cap on the finished ZIP. Output size is not known in advance, so it is applied as an
   * extra bound on source bytes: compressed data is never meaningfully larger than its
   * source, so the part stays under the cap even for incompressible content.
   */
  maxOutputBytesPerPart: number;
  /** Pack a file that alone exceeds the size limit (in a part of its own). If false it is skipped. */
  processOverMax: boolean;
}

export interface SplitResult {
  parts: FileInfo[][];
  /** Files left out because they exceed the limit and `processOverMax` is off. */
  skipped: FileInfo[];
}

export function limitsFromZipSettings(zip: ZipSettings): SplitLimits {
  return {
    maxFilesPerPart: zip.maxFilesPerZip,
    maxSourceBytesPerPart: zip.maxSourceMbPerZip * MB,
    maxOutputBytesPerPart: zip.maxOutputZipMb * MB,
    processOverMax: zip.processOverMax,
  };
}

/** `part-001.zip` for index 1. */
export function partName(index: number): string {
  return `${PART_NAME_PREFIX}${String(index).padStart(3, "0")}${PART_NAME_EXT}`;
}

function sizeCap(limits: SplitLimits): number {
  const caps = [limits.maxSourceBytesPerPart, limits.maxOutputBytesPerPart].filter((n) => n > 0);
  return caps.length === 0 ? Infinity : Math.min(...caps);
}

/**
 * Group files into parts, in the given order, without exceeding the file-count or size
 * limits. Every input file lands in exactly one part or in `skipped`. A part exceeds the
 * size cap only when it holds a single over-max file.
 */
export function splitFiles(files: readonly FileInfo[], limits: SplitLimits): SplitResult {
  const maxFiles = limits.maxFilesPerPart > 0 ? limits.maxFilesPerPart : Infinity;
  const maxBytes = sizeCap(limits);

  const parts: FileInfo[][] = [];
  const skipped: FileInfo[] = [];
  let current: FileInfo[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length > 0) parts.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const file of files) {
    if (file.size > maxBytes) {
      if (!limits.processOverMax) {
        skipped.push(file);
        continue;
      }
      flush();
      parts.push([file]);
      continue;
    }
    if (current.length + 1 > maxFiles || currentBytes + file.size > maxBytes) flush();
    current.push(file);
    currentBytes += file.size;
  }
  flush();

  return { parts, skipped };
}
