import { describe, expect, it } from "vitest";
import { chunkBytes } from "../../src/helpers/chunk";
import { Sha256, fromHex, sha256Hex, sha256HexStream, toHex } from "../../src/crypto/hash";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
/** Independent reference: the platform's own SHA-256 (Web Crypto). */
const reference = async (data: Uint8Array): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));

describe("sha256 known vectors (FIPS 180-4 / NIST)", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
  ])("hashes %j", (input, expected) => {
    expect(sha256Hex(enc(input))).toBe(expected);
  });

  it("hashes one million 'a' characters", () => {
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("streaming", () => {
  it("gives the same digest regardless of how input is split", async () => {
    const data = randomBytes(1000);
    const expected = await reference(data);
    for (const size of [1, 3, 55, 56, 63, 64, 65, 127, 128, 999, 1000]) {
      const h = new Sha256();
      for (const part of chunkBytes(data, size)) h.update(part);
      expect(h.digestHex()).toBe(expected);
    }
  });

  it("matches Web Crypto across padding boundaries", async () => {
    for (let len = 0; len <= 200; len++) {
      const data = randomBytes(len);
      expect(sha256Hex(data)).toBe(await reference(data));
    }
  });

  it("sha256HexStream accepts sync and async iterables", async () => {
    const data = randomBytes(5000);
    const parts = chunkBytes(data, 777);
    expect(await sha256HexStream(parts)).toBe(await reference(data));
    async function* gen(): AsyncGenerator<Uint8Array> {
      for (const p of parts) yield p;
    }
    expect(await sha256HexStream(gen())).toBe(await reference(data));
  });

  it("refuses reuse after digest()", () => {
    const h = new Sha256().update(enc("x"));
    h.digest();
    expect(() => h.update(enc("y"))).toThrow();
    expect(() => h.digest()).toThrow();
  });

  it("handles sub-array views with a non-zero byteOffset", async () => {
    const backing = randomBytes(300);
    const view = backing.subarray(17, 211);
    expect(sha256Hex(view)).toBe(await reference(view));
  });
});

describe("hex helpers", () => {
  it("round-trips and validates", () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 255]);
    expect(toHex(bytes)).toBe("00010f10ff");
    expect(fromHex("00010f10ff")).toEqual(bytes);
    expect(fromHex("00010F10FF")).toEqual(bytes);
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
  });
});
