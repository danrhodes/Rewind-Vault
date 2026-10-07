import { describe, expect, it } from "vitest";
import { ENCRYPTION } from "../../src/constants";
import { toHex } from "../../src/crypto/hash";
import { assertIterations, deriveKeyBytes, generateSalt, pbkdf2Sha256 } from "../../src/crypto/kdf";
import { ConfigError } from "../../src/helpers/errors";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("pbkdf2Sha256 known vectors", () => {
  // PBKDF2-HMAC-SHA256, P="password", S="salt", dkLen=32 (widely published test vectors).
  it.each([
    [1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"],
    [2, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"],
    [4096, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"],
  ])("c=%i", async (iterations, expected) => {
    expect(toHex(await pbkdf2Sha256("password", enc("salt"), iterations, 32))).toBe(expected);
  });

  it("supports longer output (dkLen=40, c=4096)", async () => {
    const out = await pbkdf2Sha256(
      "passwordPASSWORDpassword",
      enc("saltSALTsaltSALTsaltSALTsaltSALTsalt"),
      4096,
      40,
    );
    expect(toHex(out)).toBe(
      "348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9",
    );
  });

  it("rejects bad iteration counts", async () => {
    await expect(pbkdf2Sha256("p", enc("s"), 0, 32)).rejects.toBeInstanceOf(ConfigError);
    await expect(pbkdf2Sha256("p", enc("s"), 1.5, 32)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("deriveKeyBytes (policy)", () => {
  it("rejects iteration counts below the minimum", async () => {
    await expect(
      deriveKeyBytes("pw", generateSalt(), ENCRYPTION.minIterations - 1),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(() => assertIterations(1000)).toThrow(ConfigError);
    expect(() => assertIterations(ENCRYPTION.minIterations)).not.toThrow();
  });

  it("rejects an empty passphrase", async () => {
    await expect(deriveKeyBytes("", generateSalt())).rejects.toBeInstanceOf(ConfigError);
  });

  it("is deterministic, 32 bytes, and sensitive to passphrase, salt and iterations", async () => {
    const salt = generateSalt();
    const base = await deriveKeyBytes("correct horse", salt);
    expect(base).toHaveLength(32);
    expect(await deriveKeyBytes("correct horse", salt)).toEqual(base);
    expect(await deriveKeyBytes("correct horsf", salt)).not.toEqual(base);
    expect(await deriveKeyBytes("correct horse", generateSalt())).not.toEqual(base);
    expect(await deriveKeyBytes("correct horse", salt, ENCRYPTION.minIterations + 1)).not.toEqual(
      base,
    );
  });

  it("default iteration count is the policy minimum", async () => {
    const salt = enc("0123456789abcdef");
    expect(await deriveKeyBytes("pw", salt)).toEqual(
      await pbkdf2Sha256("pw", salt, ENCRYPTION.minIterations, 32),
    );
  });
});

describe("generateSalt", () => {
  it("returns random bytes of the requested length", () => {
    expect(generateSalt()).toHaveLength(ENCRYPTION.saltBytes);
    expect(generateSalt(32)).toHaveLength(32);
    expect(generateSalt()).not.toEqual(generateSalt());
  });
});
