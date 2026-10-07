import { inflateSync, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { packPart } from "../../src/core/Packer";
import { decrypt, importAesKey } from "../../src/crypto/cipher";
import { sha256Hex } from "../../src/crypto/hash";
import { CancelledError, ConfigError } from "../../src/helpers/errors";
import type { FileInfo } from "../../src/types";
import { MockClock } from "../mocks/MockClock";
import { MockVaultStore } from "../mocks/MockVaultStore";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const noYield = async (): Promise<void> => undefined;

async function vault(contents: Record<string, string | Uint8Array>) {
  const store = new MockVaultStore(new MockClock(1_790_000_000_000));
  const files: FileInfo[] = [];
  for (const [path, v] of Object.entries(contents)) {
    const bytes = typeof v === "string" ? enc(v) : v;
    await store.writeBinary(path, bytes);
    files.push({ path, size: bytes.length, mtime: 1_790_000_000_000 });
  }
  return { store, files };
}

const pack = (
  store: MockVaultStore,
  files: FileInfo[],
  opts: Parameters<typeof packPart>[2],
): ReturnType<typeof packPart> => packPart(store, files, opts, noYield);

describe("packPart (unencrypted)", () => {
  it.each([0, 1, 6, 9])("produces a standard ZIP at level %i that round-trips", async (level) => {
    const big = enc("lorem ipsum ".repeat(500));
    const { store, files } = await vault({
      "a.md": "hello",
      "notes/deep/b.md": "world",
      "empty.md": "",
      "bin/data.bin": Uint8Array.from({ length: 300 }, (_, i) => i % 256),
      "big.txt": big,
    });
    const part = await pack(store, files, { compressionLevel: level });

    const unzipped = unzipSync(part.data);
    expect(Object.keys(unzipped).sort()).toEqual(
      ["a.md", "bin/data.bin", "big.txt", "empty.md", "notes/deep/b.md"].sort(),
    );
    expect(dec(unzipped["a.md"] as Uint8Array)).toBe("hello");
    expect(dec(unzipped["notes/deep/b.md"] as Uint8Array)).toBe("world");
    expect(unzipped["empty.md"]).toHaveLength(0);
    expect(unzipped["big.txt"]).toEqual(big);
    if (level === 0) expect(part.data.length).toBeGreaterThan(big.length);
    else expect(part.data.length).toBeLessThan(big.length);
  });

  it("returns entries with size and hash of the bytes actually read, and the part hash", async () => {
    const { store, files } = await vault({ "a.md": "hello", "b.md": "world!" });
    const part = await pack(store, files, { compressionLevel: 6 });
    expect(part.entries).toEqual([
      { path: "a.md", size: 5, mtime: 1_790_000_000_000, sha256: sha256Hex(enc("hello")) },
      { path: "b.md", size: 6, mtime: 1_790_000_000_000, sha256: sha256Hex(enc("world!")) },
    ]);
    expect(part.sha256).toBe(sha256Hex(part.data));
    expect(part.skipped).toEqual([]);
  });

  it("records the size it read even if the scan was stale", async () => {
    const { store } = await vault({ "a.md": "now longer than scanned" });
    const part = await pack(store, [{ path: "a.md", size: 1, mtime: 5 }], { compressionLevel: 6 });
    expect(part.entries[0]!.size).toBe("now longer than scanned".length);
  });

  it("preserves non-ASCII file names", async () => {
    const { store, files } = await vault({ "日記/résumé 📝.md": "x" });
    const part = await pack(store, files, { compressionLevel: 6 });
    expect(Object.keys(unzipSync(part.data))).toEqual(["日記/résumé 📝.md"]);
  });

  it("handles an empty file list as a valid empty ZIP", async () => {
    const { store } = await vault({});
    const part = await pack(store, [], { compressionLevel: 6 });
    expect(Object.keys(unzipSync(part.data))).toEqual([]);
    expect(part.entries).toEqual([]);
  });

  it("clamps pre-1980 timestamps instead of failing", async () => {
    const { store } = await vault({ "old.md": "x" });
    const part = await pack(store, [{ path: "old.md", size: 1, mtime: 0 }], {
      compressionLevel: 6,
    });
    expect(Object.keys(unzipSync(part.data))).toEqual(["old.md"]);
    expect(part.entries[0]!.mtime).toBe(0);
  });
});

describe("packPart (encrypted)", () => {
  it("stores deflate-then-encrypt payloads that decrypt back to the originals", async () => {
    const key = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
    const text = "secret note ".repeat(200);
    const { store, files } = await vault({ "a.md": "tiny", "long.md": text });
    const part = await pack(store, files, {
      compressionLevel: 6,
      encryptionKey: key,
      chunkSize: 64,
    });

    expect(dec(part.data)).not.toContain("secret note");
    const unzipped = unzipSync(part.data);
    expect(Object.keys(unzipped).sort()).toEqual(["a.md", "long.md"]);
    for (const [name, original] of [
      ["a.md", "tiny"],
      ["long.md", text],
    ] as const) {
      const plain = inflateSync(await decrypt(key, unzipped[name] as Uint8Array));
      expect(dec(plain)).toBe(original);
    }
    expect(part.entries[1]!.sha256).toBe(sha256Hex(enc(text)));
  });

  it("the wrong key cannot read an entry", async () => {
    const k1 = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
    const k2 = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
    const { store, files } = await vault({ "a.md": "x" });
    const part = await pack(store, files, { compressionLevel: 6, encryptionKey: k1 });
    await expect(decrypt(k2, unzipSync(part.data)["a.md"] as Uint8Array)).rejects.toThrow();
  });
});

describe("packPart error handling", () => {
  it("skips files that vanished after the scan and reports them", async () => {
    const { store, files } = await vault({ "a.md": "x", "b.md": "y" });
    await store.remove("a.md");
    const part = await pack(store, files, { compressionLevel: 6 });
    expect(part.skipped).toEqual(["a.md"]);
    expect(part.entries.map((e) => e.path)).toEqual(["b.md"]);
    expect(Object.keys(unzipSync(part.data))).toEqual(["b.md"]);
  });

  it("rethrows read errors for files that still exist", async () => {
    const { store, files } = await vault({ "a.md": "x" });
    store.readBinary = async () => {
      throw new Error("EIO");
    };
    await expect(pack(store, files, { compressionLevel: 6 })).rejects.toThrow("EIO");
  });

  it("cancels between files", async () => {
    const { store, files } = await vault({ "a.md": "x", "b.md": "y" });
    let calls = 0;
    await expect(
      packPart(store, files, { compressionLevel: 6 }, noYield, () => ++calls > 1),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it.each([-1, 10, 1.5, NaN])("rejects compression level %s", async (level) => {
    const { store, files } = await vault({ "a.md": "x" });
    await expect(pack(store, files, { compressionLevel: level })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("yields to the UI once per file", async () => {
    const { store, files } = await vault({ "a.md": "x", "b.md": "y", "c.md": "z" });
    let yields = 0;
    await packPart(store, files, { compressionLevel: 6 }, async () => void yields++);
    expect(yields).toBe(3);
  });
});
