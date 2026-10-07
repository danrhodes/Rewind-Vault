// Schema versions, file names and fixed defaults. Full settings defaults live in settings/defaults.ts.

export const PLUGIN_ID = "rewind-vault";
export const COMMAND_PREFIX = "Rewind Vault:";

export const SCHEMA_VERSION = {
  settings: 1,
  manifest: 1,
  index: 1,
  state: 1,
  checkpoint: 1,
  lock: 1,
} as const;

/** Files inside the backup folder (PLAN §6). */
export const FILE_NAMES = {
  index: "index.json",
  state: "state.json",
  lock: "lock.json",
  checkpoint: "checkpoint.json",
  deepVerify: "deep-verify.json",
  log: "log.txt",
  manifest: "manifest.json",
  tempSuffix: ".tmp",
} as const;

export const BACKUP_FOLDER_SUFFIX = { full: "full", diff: "diff" } as const;
export const PART_NAME_PREFIX = "part-";
export const PART_NAME_EXT = ".zip";

export const DEFAULT_BACKUP_FOLDER = "backup";
export const DEFAULT_RESTORE_FOLDER = "restore";

export const ENCRYPTION = {
  algo: "AES-256-GCM",
  kdf: "PBKDF2-SHA256",
  /** PLAN §6: never go below 600,000 iterations. */
  minIterations: 600_000,
  saltBytes: 16,
  ivBytes: 12,
} as const;

export const LIMITS = {
  startupDelayMaxSec: 300,
  compressionLevelMin: 0,
  compressionLevelMax: 9,
  defaultLockTimeoutMin: 30,
  defaultLogCapKb: 512,
} as const;
