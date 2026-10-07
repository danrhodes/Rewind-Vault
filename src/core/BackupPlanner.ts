import { generateSalt } from "../crypto/kdf";
import { toBase64 } from "../helpers/bytes";
import { backupFolderName } from "../helpers/time";
import type { IVaultStore } from "../storage/VaultStore";
import type {
  BackupIndex,
  BackupState,
  BackupType,
  EntryAction,
  FileInfo,
  SettingsProfile,
  Tombstone,
} from "../types";
import { diffVault, type HashedFile } from "./Differ";
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

export interface PlanInput {
  store: IVaultStore;
  profile: SettingsProfile;
  requested: BackupType;
  now: number;
  index: BackupIndex;
  /** Null when state.json is unusable. An `updatedAt` of 0 means it never existed. */
  state: BackupState | null;
  yieldIfNeeded?: () => Promise<void>;
}

export interface PlanOutcome {
  plan: RunPlan;
  /** Differential run in which nothing was added, changed or deleted. */
  noChanges: boolean;
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

/** The newest intact full backup, which new differentials build on. */
export function latestFullBase(index: BackupIndex): string | null {
  const fulls = index.backups
    .filter((b) => b.type === "full" && b.status === "ok")
    .sort((a, b) => b.createdAt - a.createdAt);
  return fulls[0]?.id ?? null;
}

/** Null when a differential is possible, otherwise the reason it must be a full backup. */
function reasonForFull(input: PlanInput): string | null {
  if (input.requested === "full") return null;
  if (input.state === null) return "the saved file state is unreadable";
  if (input.state.updatedAt === 0) return "there is no previous backup state";
  const base = input.index.backups.find((b) => b.id === latestFullBase(input.index));
  if (!base) return "there is no intact full backup to build on";
  // A backup newer than the base that failed verification sits in the chain a new differential
  // would extend (or is a failed full): it would never be restorable, and the saved file state
  // assumes its contents are safely stored. Start again from a full backup.
  if (
    input.profile.verification.onFailureForceFull &&
    input.index.backups.some((b) => b.status === "corrupt" && b.createdAt >= base.createdAt)
  ) {
    return "a recent backup failed verification";
  }
  return null;
}

const toPlanned = (files: readonly FileInfo[], action: EntryAction): PlannedFile[] =>
  files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, action }));

export async function planBackup(input: PlanInput): Promise<PlanOutcome> {
  const { store, profile, now } = input;
  const files = await scanVault(store, scanOptionsFromProfile(profile), input.yieldIfNeeded);

  const forcedFullReason = reasonForFull(input) ?? undefined;
  const type: BackupType = input.requested === "full" || forcedFullReason ? "full" : "diff";

  let toPack: PlannedFile[] = toPlanned(files, "add");
  let tombstones: Tombstone[] = [];
  let touched: HashedFile[] = [];
  let deleted: string[] = [];
  let noChanges = false;

  if (type === "diff" && input.state) {
    const diff = await diffVault(store, files, input.state, input.yieldIfNeeded);
    toPack = [...toPlanned(diff.added, "add"), ...toPlanned(diff.changed, "change")];
    deleted = diff.deleted;
    tombstones = deleted.map((path) => ({ path, deletedAt: now }));
    touched = diff.touched;
    noChanges = toPack.length === 0 && deleted.length === 0;
  }

  const split = splitFiles(toPack, limitsFromZipSettings(profile.zip));
  const actions = new Map(toPack.map((f) => [f.path, f]));
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
    baseId: type === "diff" ? latestFullBase(input.index) : null,
    createdAt,
    parts: split.parts.map((part) => part.map((f) => actions.get(f.path) as PlannedFile)),
    tombstones,
    touched,
    deleted,
    skippedOverMax: split.skipped.map((f) => f.path),
    encryption: {
      enabled: enc.enabled,
      salt: enc.enabled ? toBase64(generateSalt()) : "",
      iterations: enc.kdfIterations,
    },
    forcedFullReason,
    totalBytes: split.parts.flat().reduce((n, f) => n + f.size, 0),
  };
  return { plan, noChanges };
}
