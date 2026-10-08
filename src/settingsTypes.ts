// Settings types (PLAN section 7). Declarations only.
import type { BackupStyle, AutoVerifyLevel, NotificationLevel, Destination } from "./types";

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
  /** Extra recovery data per ZIP part, as a percent of its size (0 = off, max 50). */
  recoveryPercent: number;
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
  /** When the battery runs low and is not charging, take one last backup of unsaved changes. */
  lowBatteryFlush: boolean;
  lowBatteryFlushPct: number;
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
