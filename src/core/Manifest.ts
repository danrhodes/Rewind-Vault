import { ENCRYPTION, FILE_NAMES, SCHEMA_VERSION } from "../constants";
import { ManifestError } from "../helpers/errors";
import { writeAtomicText } from "../storage/AtomicWriter";
import { readText, type IVaultStore } from "../storage/VaultStore";
import type {
  BackupStatus,
  BackupType,
  EncryptionInfo,
  Manifest,
  ManifestEntry,
  ManifestPart,
  ManifestVerify,
  PlatformKind,
  Tombstone,
  VerifyLevel,
} from "../types";

type Obj = Record<string, unknown>;

const HEX64 = /^[0-9a-f]{64}$/;

export function manifestPath(backupFolder: string): string {
  return `${backupFolder}/${FILE_NAMES.manifest}`;
}

export interface NewManifestInit {
  id: string;
  type: BackupType;
  baseId: string | null;
  createdAt: number;
  pluginVersion: string;
  platform: PlatformKind;
  encryption: EncryptionInfo;
}

/** An empty manifest for a backup that is about to start. */
export function createManifest(init: NewManifestInit): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION.manifest,
    ...init,
    parts: [],
    entries: [],
    tombstones: [],
    status: "in-progress",
  };
}

// ---- Validation helpers: each throws ManifestError naming the offending field ----

function fail(where: string, problem: string): never {
  throw new ManifestError(`Invalid manifest: ${where} ${problem}`);
}

function obj(value: unknown, where: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "must be an object");
  }
  return value as Obj;
}

function str(o: Obj, key: string, where: string, allowEmpty = false): string {
  const v = o[key];
  if (typeof v !== "string" || (!allowEmpty && v === "")) {
    fail(`${where}.${key}`, "must be a non-empty string");
  }
  return v as string;
}

function num(o: Obj, key: string, where: string, integer = true): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
    fail(`${where}.${key}`, `must be a non-negative ${integer ? "integer" : "number"}`);
  }
  return v as number;
}

function oneOf<T extends string>(o: Obj, key: string, where: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(`${where}.${key}`, `must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function list(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) fail(`${where}.${key}`, "must be an array");
  return v as unknown[];
}

function sha(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  if (!HEX64.test(v)) fail(`${where}.${key}`, "must be 64 lowercase hex characters");
  return v;
}

/** Vault-relative, forward slashes, no way to climb out of the restore target. */
function safePath(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  const bad =
    v.startsWith("/") ||
    v.includes("\\") ||
    v.includes("\0") ||
    v.split("/").some((s) => s === ".." || s === "");
  if (bad) fail(`${where}.${key}`, "must be a safe relative path");
  return v;
}

function validateEncryption(raw: unknown): EncryptionInfo {
  const o = obj(raw, "encryption");
  const enabled = o.enabled;
  if (typeof enabled !== "boolean") fail("encryption.enabled", "must be a boolean");
  const kdf = oneOf(o, "kdf", "encryption", [ENCRYPTION.kdf]);
  const algo = oneOf(o, "algo", "encryption", [ENCRYPTION.algo]);
  const iterations = num(o, "iterations", "encryption");
  const salt = str(o, "salt", "encryption", enabled === false);
  if (enabled === true && iterations < ENCRYPTION.minIterations) {
    fail("encryption.iterations", `must be at least ${ENCRYPTION.minIterations}`);
  }
  return { enabled: enabled as boolean, kdf, iterations, salt, algo };
}

function validateParts(raw: unknown[]): ManifestPart[] {
  const names = new Set<string>();
  return raw.map((item, i) => {
    const where = `parts[${i}]`;
    const o = obj(item, where);
    const name = str(o, "name", where);
    if (names.has(name)) fail(`${where}.name`, `duplicates part "${name}"`);
    names.add(name);
    return {
      name,
      size: num(o, "size", where),
      sha256: sha(o, "sha256", where),
      entryCount: num(o, "entryCount", where),
    };
  });
}

function validateEntries(raw: unknown[], parts: ManifestPart[], type: BackupType): ManifestEntry[] {
  const partNames = new Set(parts.map((p) => p.name));
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const entries = raw.map((item, i) => {
    const where = `entries[${i}]`;
    const o = obj(item, where);
    const path = safePath(o, "path", where);
    if (seen.has(path)) fail(`${where}.path`, `duplicates entry "${path}"`);
    seen.add(path);
    const part = str(o, "part", where);
    if (!partNames.has(part)) fail(`${where}.part`, `refers to unknown part "${part}"`);
    counts.set(part, (counts.get(part) ?? 0) + 1);
    const action = oneOf(o, "action", where, ["add", "change"] as const);
    if (type === "full" && action !== "add")
      fail(`${where}.action`, 'must be "add" in a full backup');
    return {
      path,
      size: num(o, "size", where),
      mtime: num(o, "mtime", where, false),
      sha256: sha(o, "sha256", where),
      part,
      action,
    };
  });
  for (const p of parts) {
    const actual = counts.get(p.name) ?? 0;
    if (p.entryCount !== actual) {
      fail(`parts[${p.name}].entryCount`, `is ${p.entryCount} but ${actual} entries use this part`);
    }
  }
  return entries;
}

function validateTombstones(
  raw: unknown[],
  entries: ManifestEntry[],
  type: BackupType,
): Tombstone[] {
  if (type === "full" && raw.length > 0) fail("tombstones", "must be empty in a full backup");
  const entryPaths = new Set(entries.map((e) => e.path));
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `tombstones[${i}]`;
    const o = obj(item, where);
    const path = safePath(o, "path", where);
    if (seen.has(path)) fail(`${where}.path`, `duplicates tombstone "${path}"`);
    if (entryPaths.has(path)) fail(`${where}.path`, `"${path}" is both stored and deleted`);
    seen.add(path);
    return { path, deletedAt: num(o, "deletedAt", where, false) };
  });
}

function validateVerify(raw: unknown): ManifestVerify {
  const o = obj(raw, "verify");
  const level = num(o, "lastLevel", "verify");
  if (level < 1 || level > 6) fail("verify.lastLevel", "must be between 1 and 6");
  return {
    lastLevel: level as VerifyLevel,
    lastAt: num(o, "lastAt", "verify", false),
    result: oneOf(o, "result", "verify", ["pass", "fail"] as const),
  };
}

/**
 * Check an untrusted value (parsed JSON) and return a clean, typed Manifest. Unknown
 * fields are dropped. Throws ManifestError naming the first problem found.
 */
export function validateManifest(raw: unknown): Manifest {
  const o = obj(raw, "manifest");
  const version = o.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    fail("schemaVersion", "must be a positive integer");
  }
  if ((version as number) > SCHEMA_VERSION.manifest) {
    throw new ManifestError(
      `This backup was made by a newer Rewind Vault (manifest version ${version}). Update the plugin to read it.`,
    );
  }

  const type = oneOf(o, "type", "manifest", ["full", "diff"] as const);
  const baseId = o.baseId ?? null;
  if (type === "full" && baseId !== null) fail("baseId", "must be null for a full backup");
  if (type === "diff" && (typeof baseId !== "string" || baseId === "")) {
    fail("baseId", "is required for a differential backup");
  }

  const parts = validateParts(list(o, "parts", "manifest"));
  const entries = validateEntries(list(o, "entries", "manifest"), parts, type);
  const tombstones = validateTombstones(list(o, "tombstones", "manifest"), entries, type);

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION.manifest,
    id: str(o, "id", "manifest"),
    type,
    baseId: baseId as string | null,
    createdAt: num(o, "createdAt", "manifest", false),
    pluginVersion: str(o, "pluginVersion", "manifest"),
    platform: oneOf(o, "platform", "manifest", ["desktop", "mobile"] as const),
    encryption: validateEncryption(o.encryption),
    parts,
    entries,
    tombstones,
    status: oneOf<BackupStatus>(o, "status", "manifest", [
      "ok",
      "corrupt",
      "partial",
      "in-progress",
    ]),
  };
  if (o.verify !== undefined) manifest.verify = validateVerify(o.verify);
  if (o.hmac !== undefined) manifest.hmac = str(o, "hmac", "manifest");
  return manifest;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ManifestError("Manifest is not valid JSON", { cause });
  }
  return validateManifest(raw);
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}

export async function loadManifest(store: IVaultStore, backupFolder: string): Promise<Manifest> {
  const path = manifestPath(backupFolder);
  let text: string;
  try {
    text = await readText(store, path);
  } catch (cause) {
    throw new ManifestError(`Cannot read manifest at ${path}`, { cause });
  }
  return parseManifest(text);
}

/** Validates first, so an invalid manifest never reaches disk. The write is atomic. */
export async function saveManifest(
  store: IVaultStore,
  backupFolder: string,
  manifest: Manifest,
): Promise<void> {
  const valid = validateManifest(manifest);
  await writeAtomicText(store, manifestPath(backupFolder), serializeManifest(valid));
}
