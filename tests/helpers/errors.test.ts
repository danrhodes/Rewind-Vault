import { describe, expect, it } from "vitest";
import {
  BackupAdminError,
  CancelledError,
  ConfigError,
  CryptoError,
  InsufficientSpaceError,
  LockError,
  ManifestError,
  RewindError,
  StorageError,
  TamperError,
  VerificationError,
  WrongPassphraseError,
  errorMessage,
  isRewindError,
} from "../../src/helpers/errors";

describe("errors", () => {
  it("subclasses carry name, code and instanceof chain", () => {
    const cases: [RewindError, string, string][] = [
      [new StorageError("a/b.md", "Cannot read"), "StorageError", "storage"],
      [new LockError("held"), "LockError", "lock"],
      [new ManifestError("bad"), "ManifestError", "manifest"],
      [new CryptoError("bad"), "CryptoError", "crypto"],
      [new WrongPassphraseError(), "WrongPassphraseError", "wrong-passphrase"],
      [new TamperError("tag"), "TamperError", "tamper"],
      [new VerificationError("crc"), "VerificationError", "verification"],
      [new CancelledError(), "CancelledError", "cancelled"],
      [new ConfigError("x"), "ConfigError", "config"],
      [new BackupAdminError("no"), "BackupAdminError", "admin"],
      [new InsufficientSpaceError(10, 5), "InsufficientSpaceError", "insufficient-space"],
    ];
    for (const [err, name, code] of cases) {
      expect(err).toBeInstanceOf(RewindError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.code).toBe(code);
    }
  });

  it("keeps cause, path and sizes", () => {
    const root = new Error("disk");
    const s = new StorageError("x.md", "Cannot write", { cause: root });
    expect(s.cause).toBe(root);
    expect(s.path).toBe("x.md");
    expect(s.message).toBe("Cannot write: x.md");
    const space = new InsufficientSpaceError(10, 5);
    expect([space.requiredBytes, space.availableBytes]).toEqual([10, 5]);
  });

  it("isRewindError and errorMessage", () => {
    expect(isRewindError(new LockError("x"))).toBe(true);
    expect(isRewindError(new Error("x"))).toBe(false);
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});
