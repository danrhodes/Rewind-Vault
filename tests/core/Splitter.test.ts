import { describe, expect, it } from "vitest";
import {
  limitsFromZipSettings,
  partName,
  splitFiles,
  type SplitLimits,
} from "../../src/core/Splitter";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { FileInfo } from "../../src/types";

const MB = 1024 * 1024;
const f = (path: string, size: number): FileInfo => ({ path, size, mtime: 0 });
const names = (parts: FileInfo[][]): string[][] => parts.map((p) => p.map((x) => x.path));

const none: SplitLimits = {
  maxFilesPerPart: 0,
  maxSourceBytesPerPart: 0,
  maxOutputBytesPerPart: 0,
  processOverMax: true,
};

describe("splitFiles: file count", () => {
  const limits = { ...none, maxFilesPerPart: 3 };

  it("fills parts up to the limit, keeping order", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"].map((n) => f(n, 1));
    expect(names(splitFiles(files, limits).parts)).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g"],
    ]);
  });

  it("boundary: exactly N files is one part, N+1 is two", () => {
    expect(splitFiles([f("a", 1), f("b", 1), f("c", 1)], limits).parts).toHaveLength(1);
    expect(splitFiles([f("a", 1), f("b", 1), f("c", 1), f("d", 1)], limits).parts).toHaveLength(2);
  });
});

describe("splitFiles: source size", () => {
  const limits = { ...none, maxSourceBytesPerPart: 10 };

  it("boundary: files summing to exactly the limit share a part; one byte more splits", () => {
    expect(names(splitFiles([f("a", 6), f("b", 4)], limits).parts)).toEqual([["a", "b"]]);
    expect(names(splitFiles([f("a", 6), f("b", 5)], limits).parts)).toEqual([["a"], ["b"]]);
  });

  it("a file exactly at the limit is not over-max", () => {
    const r = splitFiles([f("a", 10)], { ...limits, processOverMax: false });
    expect(names(r.parts)).toEqual([["a"]]);
    expect(r.skipped).toEqual([]);
  });

  it("closes the current part before an over-max file and starts fresh after it", () => {
    const r = splitFiles([f("a", 3), f("big", 25), f("b", 3)], limits);
    expect(names(r.parts)).toEqual([["a"], ["big"], ["b"]]);
  });
});

describe("splitFiles: over-max toggle", () => {
  const base = { ...none, maxSourceBytesPerPart: 10 };

  it("processOverMax=true gives the file its own part", () => {
    const r = splitFiles([f("big", 11)], { ...base, processOverMax: true });
    expect(names(r.parts)).toEqual([["big"]]);
    expect(r.skipped).toEqual([]);
  });

  it("processOverMax=false skips it and reports it", () => {
    const r = splitFiles([f("a", 1), f("big", 11), f("b", 1)], { ...base, processOverMax: false });
    expect(names(r.parts)).toEqual([["a", "b"]]);
    expect(r.skipped.map((x) => x.path)).toEqual(["big"]);
  });
});

describe("splitFiles: output cap and combined limits", () => {
  it("the smaller of source and output caps applies; zero means unlimited", () => {
    const files = [f("a", 6), f("b", 6)];
    expect(
      splitFiles(files, { ...none, maxSourceBytesPerPart: 100, maxOutputBytesPerPart: 10 }).parts,
    ).toHaveLength(2);
    expect(
      splitFiles(files, { ...none, maxSourceBytesPerPart: 10, maxOutputBytesPerPart: 100 }).parts,
    ).toHaveLength(2);
    expect(
      splitFiles(files, { ...none, maxSourceBytesPerPart: 0, maxOutputBytesPerPart: 100 }).parts,
    ).toHaveLength(1);
    expect(splitFiles(files, none).parts).toHaveLength(1);
  });

  it("count and size limits both apply", () => {
    const limits = { ...none, maxFilesPerPart: 2, maxSourceBytesPerPart: 10 };
    const files = [f("a", 1), f("b", 1), f("c", 1), f("d", 9), f("e", 2)];
    expect(names(splitFiles(files, limits).parts)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});

describe("splitFiles: edge cases and properties", () => {
  it("empty input gives no parts", () => {
    expect(splitFiles([], { ...none, maxFilesPerPart: 5 })).toEqual({ parts: [], skipped: [] });
  });

  it("zero-byte files count toward the file limit only", () => {
    const files = [f("a", 0), f("b", 0), f("c", 0)];
    expect(
      splitFiles(files, { ...none, maxFilesPerPart: 2, maxSourceBytesPerPart: 1 }).parts,
    ).toHaveLength(2);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "random input seed %i: complete, ordered, within limits",
    (seed) => {
      let s = seed * 7919;
      const rand = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const files = Array.from({ length: 200 }, (_, i) => f(`f${i}`, Math.floor(rand() * 40)));
      const limits: SplitLimits = {
        maxFilesPerPart: 1 + Math.floor(rand() * 15),
        maxSourceBytesPerPart: 30 + Math.floor(rand() * 60),
        maxOutputBytesPerPart: 0,
        processOverMax: rand() < 0.5,
      };
      const { parts, skipped } = splitFiles(files, limits);

      const flat = parts.flat();
      expect([...flat, ...skipped].map((x) => x.path).sort()).toEqual(
        files.map((x) => x.path).sort(),
      );
      expect(flat.map((x) => x.path)).toEqual(
        files.filter((x) => flat.includes(x)).map((x) => x.path),
      );
      for (const p of parts) {
        expect(p.length).toBeGreaterThan(0);
        expect(p.length).toBeLessThanOrEqual(limits.maxFilesPerPart);
        const total = p.reduce((n, x) => n + x.size, 0);
        if (p.length > 1) expect(total).toBeLessThanOrEqual(limits.maxSourceBytesPerPart);
      }
      if (!limits.processOverMax) {
        for (const x of skipped) expect(x.size).toBeGreaterThan(limits.maxSourceBytesPerPart);
      }
    },
  );
});

describe("helpers", () => {
  it("partName pads to three digits", () => {
    expect(partName(1)).toBe("part-001.zip");
    expect(partName(42)).toBe("part-042.zip");
    expect(partName(1000)).toBe("part-1000.zip");
  });

  it("limitsFromZipSettings converts MB to bytes", () => {
    const zip = createDefaultProfile("mobile").zip;
    const l = limitsFromZipSettings(zip);
    expect(l.maxSourceBytesPerPart).toBe(zip.maxSourceMbPerZip * MB);
    expect(l.maxOutputBytesPerPart).toBe(zip.maxOutputZipMb * MB);
    expect(l.maxFilesPerPart).toBe(zip.maxFilesPerZip);
    expect(l.processOverMax).toBe(zip.processOverMax);
  });
});
