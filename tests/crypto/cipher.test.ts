import { describe, expect, it } from "vitest";
import {
  decrypt,
  decryptStream,
  encrypt,
  encryptStream,
  encryptedSize,
  importAesKey,
} from "../../src/crypto/cipher";
import { chunkBytes } from "../../src/helpers/chunk";
import { concatBytes } from "../../src/helpers/bytes";
import { ConfigError, CryptoError, RewindError, TamperError } from "../../src/helpers/errors";

const random = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
};
const newKey = (): Promise<CryptoKey> => importAesKey(random(32));
const CHUNK = 16;
const FRAME = 12 + CHUNK + 16;
const HEADER = 8;

async function frames(key: CryptoKey, data: Uint8Array): Promise<Uint8Array[]> {
  const enc = await encrypt(key, data, CHUNK);
  const out: Uint8Array[] = [];
  for (let o = HEADER; o < enc.length; o += FRAME) out.push(enc.slice(o, o + FRAME));
  return out;
}

describe("round trip", () => {
  it.each([0, 1, 15, 16, 17, 31, 32, 33, 100, 160])("plaintext of %i bytes", async (n) => {
    const key = await newKey();
    const data = random(n);
    const enc = await encrypt(key, data, CHUNK);
    expect(enc.length).toBe(encryptedSize(n, CHUNK));
    expect(await decrypt(key, enc)).toEqual(data);
  });

  it("works with the default chunk size on a multi-chunk payload", async () => {
    const key = await newKey();
    const data = random(600_000);
    expect(await decrypt(key, await encrypt(key, data))).toEqual(data);
  });

  it("is independent of how input and output are split into pieces", async () => {
    const key = await newKey();
    const data = random(1000);
    const encPieces: Uint8Array[] = [];
    for await (const p of encryptStream(key, chunkBytes(data, 7), CHUNK)) encPieces.push(p);
    const enc = concatBytes(encPieces);
    for (const size of [1, 5, 28, 29, 1000, 99999]) {
      const parts: Uint8Array[] = [];
      for await (const p of decryptStream(key, chunkBytes(enc, size))) parts.push(p);
      expect(concatBytes(parts)).toEqual(data);
    }
  });

  it("uses a fresh IV per frame and per call", async () => {
    const key = await newKey();
    const data = new Uint8Array(64).fill(7);
    const a = await frames(key, data);
    const ivs = new Set(a.map((f) => Array.from(f.subarray(0, 12)).join(",")));
    expect(ivs.size).toBe(a.length);
    expect(await encrypt(key, data, CHUNK)).not.toEqual(await encrypt(key, data, CHUNK));
  });

  it("does not leak plaintext", async () => {
    const key = await newKey();
    const enc = await encrypt(key, new TextEncoder().encode("secret secret secret"), CHUNK);
    expect(new TextDecoder().decode(enc)).not.toContain("secret");
  });
});

describe("failure modes", () => {
  it("wrong key fails", async () => {
    const enc = await encrypt(await newKey(), random(100), CHUNK);
    await expect(decrypt(await newKey(), enc)).rejects.toBeInstanceOf(TamperError);
  });

  it("flipping any single byte fails (header, iv, ciphertext, tag)", async () => {
    const key = await newKey();
    const enc = await encrypt(key, random(40), CHUNK);
    for (let i = 0; i < enc.length; i++) {
      const bad = enc.slice();
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      const err = await decrypt(key, bad).catch((e: unknown) => e);
      expect(err, `byte ${i}`).toBeInstanceOf(RewindError);
    }
  });

  it("rejects truncation at a frame boundary and mid-frame", async () => {
    const key = await newKey();
    const enc = await encrypt(key, random(64), CHUNK); // 4 full frames + final empty? (64 = 4*16)
    await expect(decrypt(key, enc.slice(0, HEADER + FRAME))).rejects.toBeInstanceOf(TamperError);
    await expect(decrypt(key, enc.slice(0, HEADER + 2 * FRAME))).rejects.toBeInstanceOf(
      TamperError,
    );
    await expect(decrypt(key, enc.slice(0, enc.length - 5))).rejects.toBeInstanceOf(TamperError);
    await expect(decrypt(key, enc.slice(0, HEADER))).rejects.toBeInstanceOf(TamperError);
    await expect(decrypt(key, enc.slice(0, 3))).rejects.toBeInstanceOf(TamperError);
  });

  it("rejects appended data", async () => {
    const key = await newKey();
    const enc = await encrypt(key, random(40), CHUNK);
    await expect(decrypt(key, concatBytes([enc, random(10)]))).rejects.toBeInstanceOf(RewindError);
    const extra = (await frames(key, random(16)))[0] as Uint8Array;
    await expect(decrypt(key, concatBytes([enc, extra]))).rejects.toBeInstanceOf(TamperError);
  });

  it("rejects reordered and duplicated frames", async () => {
    const key = await newKey();
    const header = (await encrypt(key, random(48), CHUNK)).slice(0, HEADER);
    const f = await frames(key, random(48)); // frames 0,1 full, 2 final(16 bytes)
    // Note: header was taken from another encryption but is identical for the same chunk size.
    await expect(decrypt(key, concatBytes([header, f[1]!, f[0]!, f[2]!]))).rejects.toBeInstanceOf(
      TamperError,
    );
    await expect(decrypt(key, concatBytes([header, f[0]!, f[0]!, f[2]!]))).rejects.toBeInstanceOf(
      TamperError,
    );
    // Sanity: the in-order version does decrypt.
    await expect(decrypt(key, concatBytes([header, f[0]!, f[1]!, f[2]!]))).resolves.toBeDefined();
  });

  it("rejects a non-encrypted blob and an empty input", async () => {
    const key = await newKey();
    await expect(
      decrypt(key, new TextEncoder().encode("PK\u0003\u0004 not ours")),
    ).rejects.toBeInstanceOf(CryptoError);
    await expect(decrypt(key, new Uint8Array(0))).rejects.toBeInstanceOf(TamperError);
  });

  it("rejects absurd chunk sizes in the header", async () => {
    const key = await newKey();
    const enc = await encrypt(key, random(10), CHUNK);
    const bad = enc.slice();
    new DataView(bad.buffer).setUint32(4, 0xffffffff);
    await expect(decrypt(key, bad)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("configuration", () => {
  it("requires a 32-byte key", async () => {
    await expect(importAesKey(random(16))).rejects.toBeInstanceOf(ConfigError);
    await expect(importAesKey(random(33))).rejects.toBeInstanceOf(ConfigError);
  });

  it("validates chunk size", async () => {
    const key = await newKey();
    await expect(encrypt(key, random(1), 0)).rejects.toBeInstanceOf(ConfigError);
    await expect(encrypt(key, random(1), 1.5)).rejects.toBeInstanceOf(ConfigError);
    await expect(encrypt(key, random(1), 17 * 1024 * 1024)).rejects.toBeInstanceOf(ConfigError);
    expect(() => encryptedSize(1, 0)).toThrow(ConfigError);
  });
});
