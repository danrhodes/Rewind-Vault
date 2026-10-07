import { describe, expect, it } from "vitest";
import { toHex } from "../../src/crypto/hash";
import { KEY_LABELS, deriveSubKey, hmacSha256 } from "../../src/crypto/kdf";
import { canonicalJson, signManifest, verifyManifestSignature } from "../../src/crypto/sign";
import type { Manifest } from "../../src/types";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const key = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

function manifest(): Manifest {
  return {
    schemaVersion: 1,
    id: "2026-10-07T21-24-00_full",
    type: "full",
    baseId: null,
    createdAt: 1_790_000_000_000,
    pluginVersion: "0.0.1",
    platform: "desktop",
    encryption: {
      enabled: true,
      kdf: "PBKDF2-SHA256",
      iterations: 600_000,
      salt: "c2FsdHNhbHRzYWx0",
      algo: "AES-256-GCM",
    },
    parts: [{ name: "part-001.zip", size: 100, sha256: "a".repeat(64), entryCount: 1 }],
    entries: [
      {
        path: "notes/a.md",
        size: 5,
        mtime: 1,
        sha256: "b".repeat(64),
        part: "part-001.zip",
        action: "add",
      },
    ],
    tombstones: [],
    status: "ok",
  };
}

describe("hmac and subkeys", () => {
  it("hmacSha256 matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256(enc("Jefe"), enc("what do ya want for nothing?"));
    expect(toHex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("subkeys are deterministic, 32 bytes, and differ by label and master", async () => {
    const master = key();
    const a = await deriveSubKey(master, KEY_LABELS.encrypt);
    expect(a).toHaveLength(32);
    expect(await deriveSubKey(master, KEY_LABELS.encrypt)).toEqual(a);
    expect(await deriveSubKey(master, KEY_LABELS.manifestHmac)).not.toEqual(a);
    expect(await deriveSubKey(key(), KEY_LABELS.encrypt)).not.toEqual(a);
  });
});

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });
});

describe("manifest signing", () => {
  it("verifies an untouched manifest", async () => {
    const k = key();
    const m = manifest();
    m.hmac = await signManifest(m, k);
    expect(await verifyManifestSignature(m, k)).toBe(true);
  });

  it("verifies after a JSON round trip with reordered keys", async () => {
    const k = key();
    const m = manifest();
    m.hmac = await signManifest(m, k);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(m).reverse())));
    expect(await verifyManifestSignature(reordered, k)).toBe(true);
  });

  const tampers: [string, (m: Manifest) => void][] = [
    ["entry path", (m) => void (m.entries[0]!.path = "notes/evil.md")],
    ["entry size", (m) => void (m.entries[0]!.size = 6)],
    ["entry hash", (m) => void (m.entries[0]!.sha256 = "c".repeat(64))],
    ["part hash", (m) => void (m.parts[0]!.sha256 = "d".repeat(64))],
    ["tombstone added", (m) => void m.tombstones.push({ path: "x.md", deletedAt: 1 })],
    ["entry removed", (m) => void m.entries.pop()],
    ["id", (m) => void (m.id = "other")],
    ["baseId", (m) => void (m.baseId = "x")],
    ["created time", (m) => void (m.createdAt += 1)],
    ["kdf iterations", (m) => void (m.encryption.iterations = 1)],
    ["salt", (m) => void (m.encryption.salt = "AAAA")],
  ];
  it.each(tampers)("detects tampering with %s", async (_name, mutate) => {
    const k = key();
    const m = manifest();
    m.hmac = await signManifest(m, k);
    mutate(m);
    expect(await verifyManifestSignature(m, k)).toBe(false);
  });

  it("does not cover status or verify, which change after creation", async () => {
    const k = key();
    const m = manifest();
    m.hmac = await signManifest(m, k);
    m.status = "corrupt";
    m.verify = { lastLevel: 3, lastAt: 5, result: "fail" };
    expect(await verifyManifestSignature(m, k)).toBe(true);
  });

  it("rejects the wrong key, a missing signature and a malformed one", async () => {
    const m = manifest();
    m.hmac = await signManifest(m, key());
    expect(await verifyManifestSignature(m, key())).toBe(false);
    expect(await verifyManifestSignature(manifest(), key())).toBe(false);
    expect(await verifyManifestSignature({ ...m, hmac: "!!!not base64" }, key())).toBe(false);
    expect(await verifyManifestSignature({ ...m, hmac: "" }, key())).toBe(false);
  });
});
