import { FILE_NAMES, SCHEMA_VERSION } from "../constants";
import { sha256Hex } from "../crypto/hash";
import { recoverAtomic, writeAtomicText } from "../storage/AtomicWriter";
import { readText, type IVaultStore } from "../storage/VaultStore";
import type { ManifestEntry, ManifestPart } from "../types";
import type { RunPlan } from "./BackupPlanner";

/**
 * Written after every finished part so a backup killed half way (app closed, phone
 * suspended, crash) can continue instead of starting over. Lives next to index.json.
 */
export interface CheckpointData {
  schemaVersion: number;
  plan: RunPlan;
  /** How many entries of `plan.parts` have been handled (packed and written, or empty). */
  nextPartIndex: number;
  parts: ManifestPart[];
  entries: ManifestEntry[];
  skippedFiles: string[];
  bytes: number;
  savedAt: number;
}

export function checkpointPath(backupFolder: string): string {
  return `${backupFolder}/${FILE_NAMES.checkpoint}`;
}

export async function saveCheckpoint(
  store: IVaultStore,
  backupFolder: string,
  data: CheckpointData,
): Promise<void> {
  await writeAtomicText(store, checkpointPath(backupFolder), JSON.stringify(data));
}

export async function clearCheckpoint(store: IVaultStore, backupFolder: string): Promise<void> {
  const path = checkpointPath(backupFolder);
  await recoverAtomic(store, path);
  if (await store.exists(path)) await store.remove(path);
}

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

/** Structural sanity check. Anything doubtful is treated as "no checkpoint". */
function looksValid(raw: unknown): raw is CheckpointData {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  const plan = o.plan as Record<string, unknown> | undefined;
  return (
    o.schemaVersion === SCHEMA_VERSION.checkpoint &&
    typeof plan === "object" &&
    plan !== null &&
    typeof plan.id === "string" &&
    typeof plan.folder === "string" &&
    (plan.type === "full" || plan.type === "diff") &&
    isArray(plan.parts) &&
    isArray(plan.tombstones) &&
    isArray(plan.touched) &&
    isArray(plan.deleted) &&
    typeof o.nextPartIndex === "number" &&
    o.nextPartIndex >= 0 &&
    o.nextPartIndex <= plan.parts.length &&
    isArray(o.parts) &&
    isArray(o.entries) &&
    isArray(o.skippedFiles) &&
    typeof o.bytes === "number"
  );
}

/** The saved checkpoint, or null when there is none or it is unreadable. */
export async function loadCheckpoint(
  store: IVaultStore,
  backupFolder: string,
): Promise<CheckpointData | null> {
  const path = checkpointPath(backupFolder);
  await recoverAtomic(store, path);
  if (!(await store.exists(path))) return null;
  try {
    const raw: unknown = JSON.parse(await readText(store, path));
    return looksValid(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** True when every part already written still exists with the recorded size and hash. */
export async function completedPartsIntact(
  store: IVaultStore,
  folderPath: string,
  data: CheckpointData,
): Promise<boolean> {
  try {
    for (const part of data.parts) {
      const bytes = await store.readBinary(`${folderPath}/${part.name}`);
      if (bytes.length !== part.size || sha256Hex(bytes) !== part.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}
