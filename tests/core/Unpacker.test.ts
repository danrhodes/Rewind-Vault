import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { packPart } from "../../src/core/Packer";
import { unpackAll, unpackPart } from "../../src/core/Unpacker";
import { importAesKey } from "../../src/crypto/cipher";
import { sha256Hex } from "../../src/crypto/hash";
import { RewindError, TamperError, VerificationError } from "../../src/helpers/errors";
import type { FileInfo } from "../../src/types";
import { MockVaultStore } from "../mocks/MockVaultStore";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const noYield = async (): Promise<void> => undefined;

async function build(
  contents: Record<string, Uint8Array>,
  opts: { level?: number; key?: CryptoKey } = {},
): Promise<{ store: MockVaultStore; expected: Map<string, string> }> {
  const source = new MockVaultStore();
  const files: FileInfo[] = [];
  const expected = new Map<string, string>();
  for (const [path, data] of Object.entries(contents)) {
    await source.writeBinary(path, data);
    files.push({ path, size: data.length, mtime: 1_790_000_000_000 });
    expected.set(path, sha256Hex(data));
  }
  const part = await packPart(
    source,
    files,
    { compressionLevel: opts.level ?? 6, encryptionKey: opts.key, chunkSize: 64 },
    noYield,
  );
  const store = new MockVaultStore();
  await store.writeBinary("part-001.zip", part.data);
  return { store, expected };
}

const sample = (): Record<string, Uint8Array> => ({
  "a.md": enc("hello"),
  "notes/deep/b.md": enc("lorem ipsum ".repeat(300)),
  "empty.md": new Uint8Array(0),
  "bin.dat": Uint8Array.from({ length: 700 }, (_, i) => (i * 31) % 256),
  "日記/résumé.md": enc("unicode"),
});

describe("unpackPart (unencrypted)", () => {
  it.each([0, 1, 6, 9])("returns every entry intact at level %i", async (level) => {
    const original = sample();
    const { store } = await build(original, { level });
    const out = await unpackAll(store, "part-001.zip");
    expect([...out.keys()].sort()).toEqual(Object.keys(original).sort());
    for (const [path, data] of Object.entries(original)) expect(out.get(path)).toEqual(data);
  });

  it("yields entries one at a time, in archive order", async () => {
    const original = sample();
    const { store } = await build(original);
    const seen: string[] = [];
    for await (const e of unpackPart(store, "part-001.zip")) seen.push(e.path);
    expect(seen).toEqual(Object.keys(original));
  });

  it("handles an entry far larger than the read chunk", async () => {
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 8)) % 256);
    const { store } = await build({ "big.bin": big, "after.md": enc("x") });
    const out = await unpackAll(store, "part-001.zip", { readChunkBytes: 1000 });
    expect(out.get("big.bin")).toEqual(big);
    expect(out.get("after.md")).toEqual(enc("x"));
  });

  it("an empty part yields nothing", async () => {
    const { store } = await build({});
    expect((await unpackAll(store, "part-001.zip")).size).toBe(0);
  });
});

describe("filter", () => {
  it("returns only matching entries", async () => {
    const { store } = await build(sample());
    const out = await unpackAll(store, "part-001.zip", { filter: (p) => p.startsWith("notes/") });
    expect([...out.keys()]).toEqual(["notes/deep/b.md"]);
  });

  it("skipped entries are never decoded, so damage inside them cannot cause an error", async () => {
    const { store } = await build({ "keep.md": enc("fine"), "junk.md": enc("x".repeat(500)) });
    const bytes = (await store.readBinary("part-001.zip")).slice();
    const name = enc("junk.md");
    const at = bytes.findIndex((_, i) => name.every((b, k) => bytes[i + k] === b));
    expect(at).toBeGreaterThan(0);
    // Wreck the compressed payload that follows the local header's file name.
    for (let k = at + name.length; k < at + name.length + 6; k++) bytes[k] = (bytes[k] ?? 0) ^ 0xff;
    await store.writeBinary("damaged.zip", bytes);

    const out = await unpackAll(store, "damaged.zip", { filter: (p) => p === "keep.md" });
    expect(out.get("keep.md")).toEqual(enc("fine"));
    await expect(unpackAll(store, "damaged.zip")).rejects.toBeInstanceOf(RewindError);
  });

  it("a filter that rejects everything yields nothing", async () => {
    const { store } = await build(sample());
    expect((await unpackAll(store, "part-001.zip", { filter: () => false })).size).toBe(0);
  });
});

describe("hash verification", () => {
  it("passes when hashes match", async () => {
    const { store, expected } = await build(sample());
    expect((await unpackAll(store, "part-001.zip", { expectedSha256: expected })).size).toBe(5);
  });

  it("throws VerificationError naming the file when a hash differs", async () => {
    const { store, expected } = await build(sample());
    expected.set("a.md", sha256Hex(enc("something else")));
    const err = await unpackAll(store, "part-001.zip", { expectedSha256: expected }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerificationError);
    expect((err as Error).message).toContain("a.md");
  });

  it("only checks entries it was given hashes for", async () => {
    const { store } = await build(sample());
    const partial = new Map([["a.md", sha256Hex(enc("hello"))]]);
    expect((await unpackAll(store, "part-001.zip", { expectedSha256: partial })).size).toBe(5);
  });

  it("a hash mismatch in a filtered-out entry is ignored", async () => {
    const { store, expected } = await build(sample());
    expected.set("bin.dat", "0".repeat(64));
    const out = await unpackAll(store, "part-001.zip", {
      expectedSha256: expected,
      filter: (p) => p === "a.md",
    });
    expect(out.size).toBe(1);
  });
});

describe("encrypted parts", () => {
  it("decrypts and inflates with the right key", async () => {
    const key = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
    const original = sample();
    const { store, expected } = await build(original, { key });
    const out = await unpackAll(store, "part-001.zip", {
      encryptionKey: key,
      expectedSha256: expected,
    });
    for (const [path, data] of Object.entries(original)) expect(out.get(path)).toEqual(data);
  });

  it("the wrong key raises TamperError", async () => {
    const key = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
    const wrong = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
    const { store } = await build(sample(), { key });
    await expect(unpackAll(store, "part-001.zip", { encryptionKey: wrong })).rejects.toBeInstanceOf(
      TamperError,
    );
  });
});

describe("damaged or hostile parts", () => {
  it("rejects unsafe entry names", async () => {
    const store = new MockVaultStore();
    for (const name of ["../escape.md", "/abs.md", "a//b.md"]) {
      await store.writeBinary("evil.zip", zipSync({ [name]: enc("x") }));
      const err = await unpackAll(store, "evil.zip").catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(VerificationError);
      expect((err as Error).message).toContain("unsafe path");
    }
  });

  it("garbage input never escapes as a raw crash", async () => {
    const store = new MockVaultStore();
    await store.seed("junk.zip", "this is not a zip file at all, just text");
    const err = await unpackAll(store, "junk.zip").catch((e: unknown) => e);
    // Either nothing was found, or a typed error was raised.
    expect(err instanceof Map || err instanceof RewindError).toBe(true);
  });

  it("a truncated part fails or yields only complete entries, never invented data", async () => {
    const original = sample();
    const { store } = await build(original);
    const bytes = await store.readBinary("part-001.zip");
    await store.writeBinary("cut.zip", bytes.slice(0, Math.floor(bytes.length / 2)));
    const got = new Map<string, Uint8Array>();
    try {
      for await (const e of unpackPart(store, "cut.zip")) got.set(e.path, e.data);
    } catch (e) {
      expect(e).toBeInstanceOf(VerificationError);
    }
    for (const [path, data] of got) expect(data).toEqual(original[path]);
  });

  it("a missing part file surfaces the storage error", async () => {
    await expect(unpackAll(new MockVaultStore(), "nope.zip")).rejects.toThrow();
  });
});
