import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { VerificationError } from "../../src/helpers/errors";
import { readZipDirectory } from "../../src/helpers/zipDirectory";

const sample = (): Uint8Array =>
  zipSync({
    "a.md": strToU8("alpha"),
    "docs/b.md": [strToU8("bravo ".repeat(50)), { level: 6 }],
    "näme ✓.md": strToU8("unicode"),
  });

describe("readZipDirectory", () => {
  it("lists names, sizes, methods and data offsets", () => {
    const entries = readZipDirectory(sample());
    expect(entries.map((e) => e.name)).toEqual(["a.md", "docs/b.md", "näme ✓.md"]);
    expect(entries.map((e) => e.size)).toEqual([5, 300, 7]);
    expect(entries[1]?.method).toBe(8);
    expect(entries[1]?.compressedSize).toBeLessThan(300);
    for (const e of entries) expect(e.dataOffset).toBeGreaterThan(e.localOffset);
  });

  it("reads an empty archive", () => {
    expect(readZipDirectory(zipSync({}))).toEqual([]);
  });

  it("reads an archive with a trailing comment", () => {
    const zip = sample();
    const comment = strToU8("hello");
    const withComment = new Uint8Array(zip.length + comment.length);
    withComment.set(zip);
    withComment.set(comment, zip.length);
    // Patch the comment length field of the end record (last 22 bytes before the comment).
    new DataView(withComment.buffer).setUint16(zip.length - 2, comment.length, true);
    expect(readZipDirectory(withComment)).toHaveLength(3);
  });

  it.each([
    ["empty input", () => new Uint8Array(0)],
    ["random bytes", () => Uint8Array.from({ length: 500 }, (_, i) => (i * 37 + 11) % 256)],
    ["truncated", () => sample().subarray(0, sample().length - 10)],
    ["half the file", () => sample().subarray(0, Math.floor(sample().length / 2))],
    ["extra trailing byte", () => Uint8Array.from([...sample(), 0])],
  ])("rejects %s", (_name, make) => {
    expect(() => readZipDirectory(make())).toThrow(VerificationError);
  });

  it("rejects a damaged end record signature", () => {
    const zip = sample().slice();
    zip[zip.length - 22] = 0;
    expect(() => readZipDirectory(zip)).toThrow(/end-of-directory/);
  });

  it("rejects a damaged central directory header", () => {
    const zip = sample().slice();
    const cd = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    zip[cd] = 0;
    expect(() => readZipDirectory(zip)).toThrow(/central directory entry 1/);
  });

  it("rejects a central directory offset pointing outside the file", () => {
    const zip = sample().slice();
    new DataView(zip.buffer).setUint32(zip.length - 6, zip.length, true);
    expect(() => readZipDirectory(zip)).toThrow(/outside the file/);
  });

  it("rejects a damaged local header", () => {
    const zip = sample().slice();
    zip[0] = 0; // first local header signature
    expect(() => readZipDirectory(zip)).toThrow(/local header/);
  });

  it("rejects a local header whose name differs from the directory", () => {
    const zip = sample().slice();
    zip[30] = zip[30] === 0x7a ? 0x79 : 0x7a; // first byte of the first local name
    expect(() => readZipDirectory(zip)).toThrow(/local header names/);
  });

  it("rejects entry data that runs past the archive", () => {
    const zip = sample().slice();
    const cd = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    new DataView(zip.buffer).setUint32(cd + 20, 0x00ffffff, true); // compressed size
    expect(() => readZipDirectory(zip)).toThrow(/past the end/);
  });
});
