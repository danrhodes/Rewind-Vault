import {
  DEFAULT_BACKUP_FOLDER,
  DEFAULT_RESTORE_FOLDER,
  ENCRYPTION,
  LIMITS,
  SCHEMA_VERSION,
} from "../constants";
import type { PlatformKind, Settings, SettingsProfile } from "../types";

/** Settings shared by both profiles. Platform differences are layered on top below. */
function baseProfile(): SettingsProfile {
  return {
    basic: {
      backupOnStartup: true,
      startupDelaySec: 15,
      autoStyle: "differential",
      includeHidden: true,
      showLegacyCommands: false,
    },
    destination: {
      destination: "vault",
      backupFolder: DEFAULT_BACKUP_FOLDER,
      restoreFolder: DEFAULT_RESTORE_FOLDER,
      externalPath: "",
    },
    zip: {
      maxFilesPerZip: 5000,
      maxSourceMbPerZip: 500,
      processOverMax: true,
      maxOutputZipMb: 500,
      compressionLevel: 6,
    },
    triggers: {
      onStartup: true,
      onResume: true,
      resumeMinGapMin: 30,
      intervalEnabled: false,
      intervalMinutes: 60,
      dailyTimes: [],
      afterEditsEnabled: false,
      afterEdits: 100,
      idleEnabled: false,
      idleMinutes: 10,
      onCreate: false,
      onDelete: false,
      onRename: false,
      onClose: false,
    },
    conditions: {
      minBatteryPct: 0,
      skipIfNoChanges: true,
      minFreeSpaceMb: 200,
      wifiOnly: false,
    },
    exclusions: {
      globs: [],
      excludeHidden: false,
      excludeObsidian: false,
      excludeGit: true,
      excludeNodeModules: true,
      excludeTrash: true,
    },
    retention: {
      keepLast: 10,
      keepDays: 0,
      gfsEnabled: false,
      gfsDaily: 7,
      gfsWeekly: 4,
      gfsMonthly: 6,
      maxFolderMb: 0,
      pinnedExempt: true,
    },
    encryption: {
      enabled: false,
      passphrase: "",
      sessionCache: true,
      promptOnDemand: true,
      kdfIterations: ENCRYPTION.minIterations,
    },
    verification: {
      autoVerify: "L2",
      samplingPct: 10,
      scheduledDeepVerify: false,
      deepVerifyIntervalDays: 30,
      onFailureForceFull: true,
      onFailureNotify: true,
    },
    safety: {
      massChangeGuard: true,
      massChangeThreshold: 200,
      massChangeWindowSec: 60,
      preRestoreSnapshot: true,
      preRiskSnapshots: true,
      lockTimeoutMin: LIMITS.defaultLockTimeoutMin,
    },
    notifications: {
      level: "errors",
      dailyNoteFailureAppend: false,
      dailyNotePath: "",
      statusBar: true,
      logSizeCapKb: LIMITS.defaultLogCapKb,
    },
    misc: {
      settingsPassphraseEnabled: false,
      lowMemoryMode: false,
      chunkSizeKb: 1024,
    },
  };
}

function desktopProfile(): SettingsProfile {
  const p = baseProfile();
  p.triggers.intervalEnabled = true;
  return p;
}

function mobileProfile(): SettingsProfile {
  const p = baseProfile();
  p.zip.maxFilesPerZip = 1000;
  p.zip.maxSourceMbPerZip = 50;
  p.zip.maxOutputZipMb = 50;
  p.conditions.minBatteryPct = 20;
  p.notifications.statusBar = false;
  p.misc.chunkSizeKb = 256;
  return p;
}

export function createDefaultProfile(kind: PlatformKind): SettingsProfile {
  return kind === "mobile" ? mobileProfile() : desktopProfile();
}

/** A fresh object on every call, so callers can mutate it safely. */
export function createDefaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION.settings,
    desktop: createDefaultProfile("desktop"),
    mobile: createDefaultProfile("mobile"),
  };
}
