// Shared data types. Pure declarations: no runtime code, no imports.

export type BackupType = "full" | "diff";
export type BackupStyle = "off" | "full" | "differential" | "non-destructive";
export type BackupStatus = "ok" | "corrupt" | "partial" | "in-progress";
export type EntryAction = "add" | "change";
export type VerifyLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type AutoVerifyLevel = "off" | "L1" | "L2" | "L3";
export type NotificationLevel = "silent" | "errors" | "verbose";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type Destination = "vault" | "external";
export type PlatformKind = "desktop" | "mobile";

// ---- Files and state ----

export interface FileInfo {
  path: string;
  size: number;
  mtime: number;
  sha256?: string;
}

/** Per-file record kept in state.json for differential comparison. */
export interface FileState {
  mtime: number;
  size: number;
  sha256: string;
}

export interface BackupState {
  schemaVersion: number;
  updatedAt: number;
  files: Record<string, FileState>;
}

// ---- Manifest (per backup folder) ----

export interface EncryptionInfo {
  enabled: boolean;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  /** Base64 salt. */
  salt: string;
  algo: "AES-256-GCM";
  /** Base64 key-check verifier (see crypto/kdf keyCheckValue). Absent in older backups. */
  keyCheck?: string;
}

export interface ManifestPart {
  name: string;
  size: number;
  sha256: string;
  entryCount: number;
}

export interface ManifestEntry {
  path: string;
  size: number;
  mtime: number;
  sha256: string;
  /** Name of the part that holds this entry. */
  part: string;
  action: EntryAction;
}

export interface Tombstone {
  path: string;
  deletedAt: number;
}

export interface ManifestVerify {
  lastLevel: VerifyLevel;
  lastAt: number;
  result: "pass" | "fail";
}

export interface Manifest {
  schemaVersion: number;
  id: string;
  type: BackupType;
  /** Id of the full backup this diff builds on. Null for full backups. */
  baseId: string | null;
  createdAt: number;
  pluginVersion: string;
  platform: PlatformKind;
  encryption: EncryptionInfo;
  parts: ManifestPart[];
  entries: ManifestEntry[];
  tombstones: Tombstone[];
  status: BackupStatus;
  verify?: ManifestVerify;
  /** Base64 HMAC of the manifest, present when signing is enabled. */
  hmac?: string;
}

// ---- Registry (index.json) ----

export interface BackupEntry {
  id: string;
  type: BackupType;
  baseId: string | null;
  createdAt: number;
  status: BackupStatus;
  pinned: boolean;
  /** Milestone name for pinned backups. */
  label?: string;
  /** Total size of all parts, bytes. */
  size: number;
  /** Folder name inside the backup folder. */
  folder: string;
}

export interface BackupIndex {
  schemaVersion: number;
  backups: BackupEntry[];
}

// ---- Verification ----

export interface VerifyIssue {
  /** Set when the issue concerns another backup than the one verified (chain check). */
  backupId?: string;
  path?: string;
  part?: string;
  message: string;
}

/** What a level 6 rehearsal found when comparing a restore (in memory) with the live vault. */
export interface RehearsalStats {
  filesRestored: number;
  bytesRestored: number;
  /** Restored content identical to the live file. */
  matchLive: number;
  /** Live file differs and was edited since the backup (not a problem). */
  changedSinceBackup: number;
  /** In the backup, gone from the live vault. */
  missingFromLive: number;
  /** In the live vault, not in the backup. */
  notInBackup: number;
}

export interface VerifyReport {
  backupId: string;
  level: VerifyLevel;
  startedAt: number;
  finishedAt: number;
  result: "pass" | "fail";
  entriesChecked: number;
  issues: VerifyIssue[];
  /** Level 6 only: the outcome of the rehearsal restore. */
  rehearsal?: RehearsalStats;
  /** Present when only a random sample of entries had their contents checked. */
  sample?: { pct: number; entriesSampled: number; entriesTotal: number };
  /** Checks that could not run (for example no passphrase for an encrypted backup). Not failures. */
  skipped?: string[];
}

// Settings types live in settingsTypes.ts (file size limit); re-exported here.
export * from "./settingsTypes";
