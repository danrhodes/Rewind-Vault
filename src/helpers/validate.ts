export type Obj = Record<string, unknown>;

const HEX64 = /^[0-9a-f]{64}$/;

export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

/** Vault-relative, forward slashes, no empty segments, no way to climb out of a restore target. */
export function isSafeRelPath(value: string): boolean {
  return !(
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment === ".." || segment === "")
  );
}

/**
 * Field-level checks for untrusted JSON. Every failure throws the error produced by
 * `makeError`, with a message naming the field, e.g. "Invalid manifest: entries[3].sha256 ...".
 */
export class FieldValidator {
  constructor(
    private readonly makeError: (message: string) => Error,
    private readonly label: string,
  ) {}

  fail(where: string, problem: string): never {
    throw this.makeError(`Invalid ${this.label}: ${where} ${problem}`);
  }

  obj(value: unknown, where: string): Obj {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(where, "must be an object");
    }
    return value as Obj;
  }

  str(o: Obj, key: string, where: string, allowEmpty = false): string {
    const v = o[key];
    if (typeof v !== "string" || (!allowEmpty && v === "")) {
      this.fail(`${where}.${key}`, "must be a non-empty string");
    }
    return v as string;
  }

  bool(o: Obj, key: string, where: string): boolean {
    const v = o[key];
    if (typeof v !== "boolean") this.fail(`${where}.${key}`, "must be a boolean");
    return v as boolean;
  }

  num(o: Obj, key: string, where: string, integer = true): number {
    const v = o[key];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < 0 ||
      (integer && !Number.isInteger(v))
    ) {
      this.fail(`${where}.${key}`, `must be a non-negative ${integer ? "integer" : "number"}`);
    }
    return v as number;
  }

  oneOf<T extends string>(o: Obj, key: string, where: string, allowed: readonly T[]): T {
    const v = o[key];
    if (typeof v !== "string" || !allowed.includes(v as T)) {
      this.fail(`${where}.${key}`, `must be one of ${allowed.join(", ")}`);
    }
    return v as T;
  }

  list(o: Obj, key: string, where: string): unknown[] {
    const v = o[key];
    if (!Array.isArray(v)) this.fail(`${where}.${key}`, "must be an array");
    return v as unknown[];
  }
}
