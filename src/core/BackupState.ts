import { FILE_NAMES, SCHEMA_VERSION } from "../constants";
import { ManifestError } from "../helpers/errors";
import { FieldValidator, isHex64, isSafeRelPath } from "../helpers/validate";
import { recoverAtomic, writeAtomicText } from "../storage/AtomicWriter";
import { readText, type IVaultStore } from "../storage/VaultStore";
import type { BackupState, FileState } from "../types";
import { emptyState } from "./Differ";

const check = new FieldValidator((message) => new ManifestError(message), "backup state");

export function statePath(backupFolder: string): string {
  return `${backupFolder}/${FILE_NAMES.state}`;
}

export function validateState(raw: unknown): BackupState {
  const o = check.obj(raw, "state");
  const version = o.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    check.fail("schemaVersion", "must be a positive integer");
  }
  if ((version as number) > SCHEMA_VERSION.state) {
    throw new ManifestError(
      `The backup state was written by a newer Rewind Vault (version ${version}). Update the plugin.`,
    );
  }
  const updatedAt = check.num(o, "updatedAt", "state", false);
  const filesRaw = check.obj(o.files, "files");
  const files: Record<string, FileState> = {};
  for (const path of Object.keys(filesRaw)) {
    if (!isSafeRelPath(path)) check.fail(`files["${path}"]`, "is not a safe relative path");
    const where = `files["${path}"]`;
    const f = check.obj(filesRaw[path], where);
    const sha256 = check.str(f, "sha256", where);
    if (!isHex64(sha256)) check.fail(`${where}.sha256`, "must be 64 lowercase hex characters");
    files[path] = {
      mtime: check.num(f, "mtime", where, false),
      size: check.num(f, "size", where),
      sha256,
    };
  }
  return { schemaVersion: SCHEMA_VERSION.state, updatedAt, files };
}

/**
 * state.json is only a cache of what the last backup saw. A missing file means "no
 * history": the next differential run backs everything up. A damaged file is an error so
 * the caller can decide (the engine falls back to a full backup).
 */
export async function loadState(store: IVaultStore, backupFolder: string): Promise<BackupState> {
  const path = statePath(backupFolder);
  await recoverAtomic(store, path);
  if (!(await store.exists(path))) return emptyState(0, SCHEMA_VERSION.state);
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(store, path));
  } catch (cause) {
    throw new ManifestError(`The backup state at ${path} is not valid JSON`, { cause });
  }
  return validateState(raw);
}

export async function saveState(
  store: IVaultStore,
  backupFolder: string,
  state: BackupState,
): Promise<void> {
  const valid = validateState(state);
  await writeAtomicText(store, statePath(backupFolder), JSON.stringify(valid));
}
