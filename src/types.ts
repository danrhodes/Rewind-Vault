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

// ---- Settings (PLAN §7). Each platform has its own profile. ----

export interface BasicSettings {
  backupOnStartup: boolean;
  /** Seconds, 0-300. */
  startupDelaySec: number;
  autoStyle: BackupStyle;
  includeHidden: boolean;
  showLegacyCommands: boolean;
}

export interface DestinationSettings {
  destination: Destination;
  backupFolder: string;
  restoreFolder: string;
  /** Absolute path for external copy (desktop only). */
  externalPath: string;
}

export interface ZipSettings {
  maxFilesPerZip: number;
  maxSourceMbPerZip: number;
  processOverMax: boolean;
  maxOutputZipMb: number;
  /** 0-9. */
  compressionLevel: number;
}

export interface TriggerSettings {
  onStartup: boolean;
  onResume: boolean;
  resumeMinGapMin: number;
  intervalEnabled: boolean;
  intervalMinutes: number;
  dailyTimes: string[];
  afterEditsEnabled: boolean;
  afterEdits: number;
  /** Back up after this many words have been typed or deleted in notes. */
  afterWordsEnabled: boolean;
  afterWords: number;
  idleEnabled: boolean;
  idleMinutes: number;
  onCreate: boolean;
  onDelete: boolean;
  onRename: boolean;
  onClose: boolean;
}

export interface ConditionSettings {
  minBatteryPct: number;
  skipIfNoChanges: boolean;
  minFreeSpaceMb: number;
  wifiOnly: boolean;
}

export interface ExclusionSettings {
  globs: string[];
  excludeHidden: boolean;
  excludeObsidian: boolean;
  excludeGit: boolean;
  excludeNodeModules: boolean;
  excludeTrash: boolean;
}

export interface RetentionSettings {
  keepLast: number;
  keepDays: number;
  gfsEnabled: boolean;
  gfsDaily: number;
  gfsWeekly: number;
  gfsMonthly: number;
  maxFolderMb: number;
  pinnedExempt: boolean;
}

export interface EncryptionSettings {
  enabled: boolean;
  /** Stored only if the user opts out of session cache and prompt-on-demand. */
  passphrase: string;
  sessionCache: boolean;
  promptOnDemand: boolean;
  kdfIterations: number;
}

export interface VerificationSettings {
  autoVerify: AutoVerifyLevel;
  samplingPct: number;
  scheduledDeepVerify: boolean;
  deepVerifyIntervalDays: number;
  /** Restore the newest backup in memory and compare it with the vault, on a schedule. */
  scheduledRehearsal: boolean;
  rehearsalIntervalDays: number;
  onFailureForceFull: boolean;
  onFailureNotify: boolean;
}

export interface SafetySettings {
  massChangeGuard: boolean;
  massChangeThreshold: number;
  massChangeWindowSec: number;
  preRestoreSnapshot: boolean;
  preRiskSnapshots: boolean;
  lockTimeoutMin: number;
}

export interface NotificationSettings {
  level: NotificationLevel;
  dailyNoteFailureAppend: boolean;
  dailyNotePath: string;
  /** Keep a "Backup Status" note with a health summary in its frontmatter. */
  statusNote: boolean;
  /** Vault path of that note; empty means "Backup Status.md" inside the backup folder. */
  statusNotePath: string;
  statusBar: boolean;
  logSizeCapKb: number;
}

export interface MiscSettings {
  settingsPassphraseEnabled: boolean;
  lowMemoryMode: boolean;
  chunkSizeKb: number;
}

export interface SettingsProfile {
  basic: BasicSettings;
  destination: DestinationSettings;
  zip: ZipSettings;
  triggers: TriggerSettings;
  conditions: ConditionSettings;
  exclusions: ExclusionSettings;
  retention: RetentionSettings;
  encryption: EncryptionSettings;
  verification: VerificationSettings;
  safety: SafetySettings;
  notifications: NotificationSettings;
  misc: MiscSettings;
}

export interface Settings {
  schemaVersion: number;
  desktop: SettingsProfile;
  mobile: SettingsProfile;
}
