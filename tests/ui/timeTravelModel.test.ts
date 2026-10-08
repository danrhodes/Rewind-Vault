import { describe, expect, it } from "vitest";
import type { PointFile } from "../../src/core/TimeTravel";
import {
  MAX_PREVIEW_BYTES,
  buildPreview,
  describeFileRow,
  describeListing,
  filterFiles,
} from "../../src/ui/timeTravelModel";

const files: PointFile[] = [
  { path: "Notes/Alpha.md", size: 10, mtime: 1 },
  { path: "img/Alpha.png", size: 20, mtime: 2 },
  { path: "Notes/beta.md", size: 30, mtime: 3 },
];

describe("filterFiles", () => {
  it("matches case-insensitively and keeps all for an empty query", () => {
    expect(filterFiles(files, "ALPHA").map((f) => f.path)).toEqual([
      "Notes/Alpha.md",
      "img/Alpha.png",
    ]);
    expect(filterFiles(files, "  ")).toEqual(files);
    expect(filterFiles(files, "zzz")).toEqual([]);
  });
});

describe("describeListing", () => {
  it("covers empty, no match, filtered, capped and plain", () => {
    expect(describeListing(0, 0, 0)).toBe("This backup holds no files.");
    expect(describeListing(3, 0, 0)).toBe("No file matches (3 files in this backup).");
    expect(describeListing(3, 2, 2)).toBe("2 of 3 files match.");
    expect(describeListing(500, 300, 200)).toBe("300 of 500 files match, first 200 shown.");
    expect(describeListing(500, 500, 200)).toBe("500 files, first 200 shown. Search to narrow.");
    expect(describeListing(1, 1, 1)).toBe("1 file.");
  });
});

describe("describeFileRow", () => {
  it("shows size and the formatted time", () => {
    expect(describeFileRow(files[0] as PointFile, (ms) => `t${ms}`)).toContain("modified t1");
  });
});

describe("buildPreview", () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  it("shows text as it is", () => {
    expect(buildPreview("a.md", bytes("hello"))).toEqual({
      kind: "text",
      text: "hello",
      truncated: false,
    });
  });
  it("explains binary types and invalid text", () => {
    expect(buildPreview("a.png", bytes("x")).kind).toBe("unavailable");
    expect(buildPreview("a.md", new Uint8Array([0xff, 0xfe, 0xfd])).kind).toBe("unavailable");
  });
  it("cuts big files, even in the middle of a multi-byte character", () => {
    const view = buildPreview("a.md", bytes("é".repeat(MAX_PREVIEW_BYTES)));
    expect(view.kind).toBe("text");
    if (view.kind === "text") expect(view.truncated).toBe(true);
    // One ASCII byte first shifts every 2-byte character so the cut lands inside one.
    expect(buildPreview("a.md", bytes("a" + "é".repeat(MAX_PREVIEW_BYTES))).kind).toBe("text");
  });
});
