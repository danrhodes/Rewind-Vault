import { RestoreError } from "../helpers/errors";
import { isInsideFolder } from "../helpers/glob";
import type { ILogger } from "../helpers/logger";
import { isSafeRelPath } from "../helpers/validate";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupEntry, SettingsProfile } from "../types";
import type { RestoreSource } from "./ChainResolver";
import type { MasterKeyFn } from "./RestoreReader";

export type RestoreScope =
  { kind: "all" } | { kind: "file"; path: string } | { kind: "folder"; path: string };

/**
 * Where restored files go. The restore folder is the safe default: files land in
 * `<restoreFolder>/<backup id>/` and nothing in the live vault is touched. Writing into the
 * vault itself is a separate, explicit choice.
 */
export type RestoreDestination = { kind: "restore-folder" } | { kind: "vault" };

export interface RestoreRequest {
  source: RestoreSource;
  scope: RestoreScope;
  destination: RestoreDestination;
  /**
   * Vault destination only: also remove files that the backup does not contain, so the
   * result matches the backup exactly. Off by default.
   */
  deleteExtraneous?: boolean;
}

export interface PreviewItem {
  path: string;
  /** Size of the restored file. */
  size: number;
  /** Backup that stores the version that would be restored. */
  backupId: string;
  /** Size of the file currently at the destination, for changes. */
  currentSize?: number;
}

export interface RestorePreview {
  source: BackupEntry;
  /** "" for the vault, otherwise the folder restored files are written under. */
  destinationRoot: string;
  /** In the backup, absent at the destination. */
  additions: PreviewItem[];
  /** In both, with different content. */
  changes: PreviewItem[];
  /** At the destination only; listed only when `deleteExtraneous` was requested. */
  deletions: string[];
  /** In both, identical. */
  unchanged: number;
  /** Bytes that would be written (additions plus changes). */
  bytesToWrite: number;
}

/**
 * Takes a backup of the live vault right now. Resolves to the new backup's id, or null when
 * the latest backup already matches the vault (nothing changed). Rejects if it fails.
 */
export type SafetySnapshotFn = () => Promise<{ backupId: string } | null>;

/** What the restore code needs from the engine. */
export interface RestoreContext {
  store: IVaultStore;
  logger: ILogger;
  profile: SettingsProfile;
  backupFolder: string;
  yieldIfNeeded: () => Promise<void>;
  deriveMasterKey?: MasterKeyFn;
  safetySnapshot?: SafetySnapshotFn;
}

/** Where a vault-relative path ends up for a destination. */
export function destinationPath(root: string, path: string): string {
  return root === "" ? path : `${root}/${path}`;
}

export function normaliseScope(scope: RestoreScope): RestoreScope {
  if (scope.kind === "all") return scope;
  const path = scope.path.replace(/\/+$/, "");
  if (!isSafeRelPath(path)) throw new RestoreError(`"${scope.path}" is not a valid vault path`);
  return { kind: scope.kind, path };
}

export function inScope(scope: RestoreScope, path: string): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "file") return path === scope.path;
  return isInsideFolder(path, scope.path) && path !== scope.path;
}
