import { toBase64 } from "../helpers/bytes";
import { generateSalt } from "../crypto/kdf";
import { backupFolderName } from "../helpers/time";
import type { IVaultStore } from "../storage/VaultStore";
import type {
  BackupIndex,
  BackupState,
  BackupType,
  EntryAction,
  SettingsProfile,
  Tombstone,
} from "../types";
import type { HashedFile } from "./Differ";
import { scanOptionsFromProfile, scanVault } from "./Scanner";
import { limitsFromZipSettings, splitFiles } from "./Splitter";

export interface PlannedFile {
  path: string;
  size: number;
  mtime: number;
  action: EntryAction;
}

/** Everything needed to carry out (or resume) one backup. JSON-serialisable on purpose. */
export interface RunPlan {
  id: string;
  /** Folder name inside the backup folder. Equals `id`. */
  folder: string;
  type: BackupType;
  baseId: string | null;
  createdAt: number;
  parts: PlannedFile[][];
  tombstones: Tombstone[];
  /** Unchanged content with a new timestamp: only state.json needs refreshing. */
  touched: HashedFile[];
  /** Paths that left the vault since the last backup. */
  deleted: string[];
  /** Over-max files left out because `processOverMax` is off. */
  skippedOverMax: string[];
  encryption: { enabled: boolean; salt: string; iterations: number };
  /** Why a differential request became a full backup, if it did. */
  forcedFullReason?: string;
  totalBytes: number;
}

export type PlanOutcome = { kind: "plan"; plan: RunPlan };

export interface PlanInput {
  store: IVaultStore;
  profile: SettingsProfile;
  requested: BackupType;
  now: number;
  index: BackupIndex;
  /** Null when state.json is missing or unusable. */
  state: BackupState | null;
  yieldIfNeeded?: () => Promise<void>;
}

/** A folder name that does not exist yet. Bumps the timestamp by whole seconds if needed. */
async function freeFolder(
  store: IVaultStore,
  backupFolder: string,
  now: number,
  type: BackupType,
): Promise<{ folder: string; createdAt: number }> {
  let createdAt = now;
  for (;;) {
    const folder = backupFolderName(createdAt, type);
    if (!(await store.exists(`${backupFolder}/${folder}`))) return { folder, createdAt };
    createdAt += 1000;
  }
}

export async function planBackup(input: PlanInput): Promise<PlanOutcome> {
  const { store, profile, now } = input;
  const files = await scanVault(store, scanOptionsFromProfile(profile), input.yieldIfNeeded);

  const type: BackupType = "full";
  const split = splitFiles(files, limitsFromZipSettings(profile.zip));
  const { folder, createdAt } = await freeFolder(
    store,
    profile.destination.backupFolder,
    now,
    type,
  );

  const enc = profile.encryption;
  const plan: RunPlan = {
    id: folder,
    folder,
    type,
    baseId: null,
    createdAt,
    parts: split.parts.map((part) =>
      part.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, action: "add" as const })),
    ),
    tombstones: [],
    touched: [],
    deleted: [],
    skippedOverMax: split.skipped.map((f) => f.path),
    encryption: {
      enabled: enc.enabled,
      salt: enc.enabled ? toBase64(generateSalt()) : "",
      iterations: enc.kdfIterations,
    },
    totalBytes: split.parts.flat().reduce((n, f) => n + f.size, 0),
  };
  return { kind: "plan", plan };
}
