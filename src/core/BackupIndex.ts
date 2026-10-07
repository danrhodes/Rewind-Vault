import { FILE_NAMES, SCHEMA_VERSION } from "../constants";
import { ManifestError } from "../helpers/errors";
import { FieldValidator } from "../helpers/validate";
import { recoverAtomic, writeAtomicText } from "../storage/AtomicWriter";
import { readText, type IVaultStore } from "../storage/VaultStore";
import type { BackupEntry, BackupIndex, Manifest } from "../types";

const check = new FieldValidator((message) => new ManifestError(message), "backup index");

export function indexPath(backupFolder: string): string {
  return `${backupFolder}/${FILE_NAMES.index}`;
}

export function emptyIndex(): BackupIndex {
  return { schemaVersion: SCHEMA_VERSION.index, backups: [] };
}

/** Registry row for a finished backup. `size` is the total of its part files. */
export function entryFromManifest(manifest: Manifest, folder: string, size: number): BackupEntry {
  return {
    id: manifest.id,
    type: manifest.type,
    baseId: manifest.baseId,
    createdAt: manifest.createdAt,
    status: manifest.status,
    pinned: false,
    size,
    folder,
  };
}

function validateEntry(raw: unknown, i: number): BackupEntry {
  const where = `backups[${i}]`;
  const o = check.obj(raw, where);
  const type = check.oneOf(o, "type", where, ["full", "diff"] as const);
  const baseId = o.baseId ?? null;
  if (type === "full" && baseId !== null)
    check.fail(`${where}.baseId`, "must be null for a full backup");
  if (type === "diff" && (typeof baseId !== "string" || baseId === "")) {
    check.fail(`${where}.baseId`, "is required for a differential backup");
  }
  const folder = check.str(o, "folder", where);
  if (folder.includes("/") || folder === "." || folder === "..") {
    check.fail(`${where}.folder`, "must be a single folder name");
  }
  const entry: BackupEntry = {
    id: check.str(o, "id", where),
    type,
    baseId: baseId as string | null,
    createdAt: check.num(o, "createdAt", where, false),
    status: check.oneOf(o, "status", where, ["ok", "corrupt", "partial", "in-progress"] as const),
    pinned: check.bool(o, "pinned", where),
    size: check.num(o, "size", where),
    folder,
  };
  if (o.label !== undefined) entry.label = check.str(o, "label", where, true);
  return entry;
}

export function validateIndex(raw: unknown): BackupIndex {
  const o = check.obj(raw, "index");
  const version = o.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    check.fail("schemaVersion", "must be a positive integer");
  }
  if ((version as number) > SCHEMA_VERSION.index) {
    throw new ManifestError(
      `The backup index was written by a newer Rewind Vault (version ${version}). Update the plugin.`,
    );
  }
  const backups = check.list(o, "backups", "index").map(validateEntry);
  const ids = new Set<string>();
  for (const b of backups) {
    if (ids.has(b.id)) check.fail("backups", `contains duplicate id "${b.id}"`);
    ids.add(b.id);
  }
  return { schemaVersion: SCHEMA_VERSION.index, backups };
}

/** Missing file means no backups yet. A damaged file is an error (never silently reset). */
export async function loadIndex(store: IVaultStore, backupFolder: string): Promise<BackupIndex> {
  const path = indexPath(backupFolder);
  await recoverAtomic(store, path);
  if (!(await store.exists(path))) return emptyIndex();
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(store, path));
  } catch (cause) {
    throw new ManifestError(`The backup index at ${path} is not valid JSON`, { cause });
  }
  return validateIndex(raw);
}

export async function saveIndex(
  store: IVaultStore,
  backupFolder: string,
  index: BackupIndex,
): Promise<void> {
  const valid = validateIndex(index);
  await writeAtomicText(store, indexPath(backupFolder), JSON.stringify(valid, null, 2));
}

// ---- Pure operations: each returns a new index and leaves the input untouched ----

export function findBackup(index: BackupIndex, id: string): BackupEntry | undefined {
  return index.backups.find((b) => b.id === id);
}

export function addBackup(index: BackupIndex, entry: BackupEntry): BackupIndex {
  if (findBackup(index, entry.id))
    throw new ManifestError(`Backup "${entry.id}" is already registered`);
  return { ...index, backups: [...index.backups, entry] };
}

export function updateBackup(
  index: BackupIndex,
  id: string,
  patch: Partial<Omit<BackupEntry, "id">>,
): BackupIndex {
  if (!findBackup(index, id)) throw new ManifestError(`Backup "${id}" is not registered`);
  return { ...index, backups: index.backups.map((b) => (b.id === id ? { ...b, ...patch } : b)) };
}

export function removeBackup(index: BackupIndex, id: string): BackupIndex {
  return { ...index, backups: index.backups.filter((b) => b.id !== id) };
}

/** Newest first. Ties (same second) fall back to id so the order is stable. */
export function sortedBackups(index: BackupIndex): BackupEntry[] {
  return [...index.backups].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** The base full backup and every diff built on it, oldest first. Null if the base is missing. */
export function chainFor(index: BackupIndex, id: string): BackupEntry[] | null {
  const target = findBackup(index, id);
  if (!target) return null;
  const baseId = target.type === "full" ? target.id : target.baseId;
  const base = baseId ? findBackup(index, baseId) : undefined;
  if (!base || base.type !== "full") return null;
  const diffs = index.backups
    .filter((b) => b.type === "diff" && b.baseId === base.id && b.createdAt <= target.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt);
  return [base, ...diffs];
}
