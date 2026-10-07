import { ENCRYPTION, FILE_NAMES, SCHEMA_VERSION } from "../constants";
import { ManifestError } from "../helpers/errors";
import { FieldValidator, isHex64, isSafeRelPath, type Obj } from "../helpers/validate";
import { recoverAtomic, writeAtomicText } from "../storage/AtomicWriter";
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

const check = new FieldValidator((message) => new ManifestError(message), "manifest");

function sha(o: Obj, key: string, where: string): string {
  const value = check.str(o, key, where);
  if (!isHex64(value)) check.fail(`${where}.${key}`, "must be 64 lowercase hex characters");
  return value;
}

function safePath(o: Obj, key: string, where: string): string {
  const value = check.str(o, key, where);
  if (!isSafeRelPath(value)) check.fail(`${where}.${key}`, "must be a safe relative path");
  return value;
}

function validateEncryption(raw: unknown): EncryptionInfo {
  const o = check.obj(raw, "encryption");
  const enabled = o.enabled;
  if (typeof enabled !== "boolean") check.fail("encryption.enabled", "must be a boolean");
  const kdf = check.oneOf(o, "kdf", "encryption", [ENCRYPTION.kdf]);
  const algo = check.oneOf(o, "algo", "encryption", [ENCRYPTION.algo]);
  const iterations = check.num(o, "iterations", "encryption");
  const salt = check.str(o, "salt", "encryption", enabled === false);
  if (enabled === true && iterations < ENCRYPTION.minIterations) {
    check.fail("encryption.iterations", `must be at least ${ENCRYPTION.minIterations}`);
  }
  const keyCheck = o.keyCheck === undefined ? undefined : check.str(o, "keyCheck", "encryption");
  return {
    enabled: enabled as boolean,
    kdf,
    iterations,
    salt,
    algo,
    ...(keyCheck !== undefined ? { keyCheck } : {}),
  };
}

function validateParts(raw: unknown[]): ManifestPart[] {
  const names = new Set<string>();
  return raw.map((item, i) => {
    const where = `parts[${i}]`;
    const o = check.obj(item, where);
    const name = check.str(o, "name", where);
    if (names.has(name)) check.fail(`${where}.name`, `duplicates part "${name}"`);
    names.add(name);
    return {
      name,
      size: check.num(o, "size", where),
      sha256: sha(o, "sha256", where),
      entryCount: check.num(o, "entryCount", where),
    };
  });
}

function validateEntries(raw: unknown[], parts: ManifestPart[], type: BackupType): ManifestEntry[] {
  const partNames = new Set(parts.map((p) => p.name));
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const entries = raw.map((item, i) => {
    const where = `entries[${i}]`;
    const o = check.obj(item, where);
    const path = safePath(o, "path", where);
    if (seen.has(path)) check.fail(`${where}.path`, `duplicates entry "${path}"`);
    seen.add(path);
    const part = check.str(o, "part", where);
    if (!partNames.has(part)) check.fail(`${where}.part`, `refers to unknown part "${part}"`);
    counts.set(part, (counts.get(part) ?? 0) + 1);
    const action = check.oneOf(o, "action", where, ["add", "change"] as const);
    if (type === "full" && action !== "add")
      check.fail(`${where}.action`, 'must be "add" in a full backup');
    return {
      path,
      size: check.num(o, "size", where),
      mtime: check.num(o, "mtime", where, false),
      sha256: sha(o, "sha256", where),
      part,
      action,
    };
  });
  for (const p of parts) {
    const actual = counts.get(p.name) ?? 0;
    if (p.entryCount !== actual) {
      check.fail(
        `parts[${p.name}].entryCount`,
        `is ${p.entryCount} but ${actual} entries use this part`,
      );
    }
  }
  return entries;
}

function validateTombstones(
  raw: unknown[],
  entries: ManifestEntry[],
  type: BackupType,
): Tombstone[] {
  if (type === "full" && raw.length > 0) check.fail("tombstones", "must be empty in a full backup");
  const entryPaths = new Set(entries.map((e) => e.path));
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `tombstones[${i}]`;
    const o = check.obj(item, where);
    const path = safePath(o, "path", where);
    if (seen.has(path)) check.fail(`${where}.path`, `duplicates tombstone "${path}"`);
    if (entryPaths.has(path)) check.fail(`${where}.path`, `"${path}" is both stored and deleted`);
    seen.add(path);
    return { path, deletedAt: check.num(o, "deletedAt", where, false) };
  });
}

function validateVerify(raw: unknown): ManifestVerify {
  const o = check.obj(raw, "verify");
  const level = check.num(o, "lastLevel", "verify");
  if (level < 1 || level > 6) check.fail("verify.lastLevel", "must be between 1 and 6");
  return {
    lastLevel: level as VerifyLevel,
    lastAt: check.num(o, "lastAt", "verify", false),
    result: check.oneOf(o, "result", "verify", ["pass", "fail"] as const),
  };
}

/**
 * Check an untrusted value (parsed JSON) and return a clean, typed Manifest. Unknown
 * fields are dropped. Throws ManifestError naming the first problem found.
 */
export function validateManifest(raw: unknown): Manifest {
  const o = check.obj(raw, "manifest");
  const version = o.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    check.fail("schemaVersion", "must be a positive integer");
  }
  if ((version as number) > SCHEMA_VERSION.manifest) {
    throw new ManifestError(
      `This backup was made by a newer Rewind Vault (manifest version ${version}). Update the plugin to read it.`,
    );
  }

  const type = check.oneOf(o, "type", "manifest", ["full", "diff"] as const);
  const baseId = o.baseId ?? null;
  if (type === "full" && baseId !== null) check.fail("baseId", "must be null for a full backup");
  if (type === "diff" && (typeof baseId !== "string" || baseId === "")) {
    check.fail("baseId", "is required for a differential backup");
  }

  const parts = validateParts(check.list(o, "parts", "manifest"));
  const entries = validateEntries(check.list(o, "entries", "manifest"), parts, type);
  const tombstones = validateTombstones(check.list(o, "tombstones", "manifest"), entries, type);

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION.manifest,
    id: check.str(o, "id", "manifest"),
    type,
    baseId: baseId as string | null,
    createdAt: check.num(o, "createdAt", "manifest", false),
    pluginVersion: check.str(o, "pluginVersion", "manifest"),
    platform: check.oneOf(o, "platform", "manifest", ["desktop", "mobile"] as const),
    encryption: validateEncryption(o.encryption),
    parts,
    entries,
    tombstones,
    status: check.oneOf<BackupStatus>(o, "status", "manifest", [
      "ok",
      "corrupt",
      "partial",
      "in-progress",
    ]),
  };
  if (o.verify !== undefined) manifest.verify = validateVerify(o.verify);
  if (o.hmac !== undefined) manifest.hmac = check.str(o, "hmac", "manifest");
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
    // A crash while the manifest was being rewritten (verification records its result there)
    // can leave it missing next to a .bak: repair that first, as for index.json and state.json.
    await recoverAtomic(store, path);
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
