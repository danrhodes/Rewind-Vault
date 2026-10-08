import type { SettingsProfile } from "../types";

/** Limits used when low-memory mode is on. Peak use is about one ZIP part held in memory. */
export const LOW_MEMORY = {
  chunkKb: 64,
  maxSourceMbPerZip: 16,
  maxOutputZipMb: 16,
  maxFilesPerZip: 500,
  /** Longest uninterrupted work slice, in ms; the normal budget is 30. */
  yieldBudgetMs: 10,
} as const;

export const NORMAL_YIELD_BUDGET_MS = 30;

/**
 * The profile with low-memory limits applied, as a copy. Only ever lowers a value, so a user
 * who set something smaller keeps it. Nothing changes when low-memory mode is off.
 */
export function applyLowMemory(profile: SettingsProfile): SettingsProfile {
  if (!profile.misc.lowMemoryMode) return profile;
  const { zip, misc } = profile;
  return {
    ...profile,
    zip: {
      ...zip,
      maxSourceMbPerZip: Math.min(zip.maxSourceMbPerZip, LOW_MEMORY.maxSourceMbPerZip),
      maxOutputZipMb: Math.min(zip.maxOutputZipMb, LOW_MEMORY.maxOutputZipMb),
      maxFilesPerZip: Math.min(zip.maxFilesPerZip, LOW_MEMORY.maxFilesPerZip),
    },
    misc: { ...misc, chunkSizeKb: Math.min(misc.chunkSizeKb, LOW_MEMORY.chunkKb) },
  };
}

/** How long long-running loops may run before giving the UI a turn. */
export function yieldBudgetMs(profile: SettingsProfile): number {
  return profile.misc.lowMemoryMode ? LOW_MEMORY.yieldBudgetMs : NORMAL_YIELD_BUDGET_MS;
}

/**
 * Rough peak memory for one backup run, in MB: the ZIP part being built plus the same again
 * for its copy while hashing and writing, plus one chunk for the encryption stage. A planning
 * figure for docs and tests, not a measurement.
 */
export function estimatePeakMb(profile: SettingsProfile): number {
  const p = applyLowMemory(profile);
  const part = Math.min(p.zip.maxSourceMbPerZip, p.zip.maxOutputZipMb);
  return part * 2 + (p.misc.chunkSizeKb * 2) / 1024;
}
