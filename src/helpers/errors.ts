export type ErrorCode =
  | "storage"
  | "lock"
  | "manifest"
  | "crypto"
  | "wrong-passphrase"
  | "tamper"
  | "verification"
  | "cancelled"
  | "config"
  | "insufficient-space"
  | "chain";

export interface ErrorOptions {
  cause?: unknown;
}

/** Base class for every error this plugin throws on purpose. */
export class RewindError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = options.cause;
  }
}

export class StorageError extends RewindError {
  readonly path: string;

  constructor(path: string, message: string, options: ErrorOptions = {}) {
    super("storage", `${message}: ${path}`, options);
    this.path = path;
  }
}

export class LockError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("lock", message, options);
  }
}

export class ManifestError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("manifest", message, options);
  }
}

export class CryptoError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("crypto", message, options);
  }
}

export class WrongPassphraseError extends RewindError {
  constructor(options: ErrorOptions = {}) {
    super("wrong-passphrase", "Wrong passphrase", options);
  }
}

/** Authentication tag or signature mismatch: data was modified or is corrupt. */
export class TamperError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("tamper", message, options);
  }
}

export class VerificationError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("verification", message, options);
  }
}

/** A backup chain cannot be followed: missing, damaged or inconsistent links. */
export class BrokenChainError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("chain", message, options);
  }
}

export class CancelledError extends RewindError {
  constructor(message = "Operation cancelled") {
    super("cancelled", message);
  }
}

export class ConfigError extends RewindError {
  constructor(message: string, options: ErrorOptions = {}) {
    super("config", message, options);
  }
}

export class InsufficientSpaceError extends RewindError {
  readonly requiredBytes: number;
  readonly availableBytes: number;

  constructor(requiredBytes: number, availableBytes: number) {
    super(
      "insufficient-space",
      `Not enough free space: need ${requiredBytes} bytes, have ${availableBytes}`,
    );
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

export function isRewindError(value: unknown): value is RewindError {
  return value instanceof RewindError;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
