import { createDefaultProfile } from "../../src/settings/defaults";
import type { BackupEntry, BackupIndex, BackupStatus, RetentionSettings } from "../../src/types";

export const DAY = 24 * 60 * 60 * 1000;
/** A fixed "now" for planner tests: 2026-10-07 12:00 UTC. */
export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

export function retention(overrides: Partial<RetentionSettings> = {}): RetentionSettings {
  return { ...createDefaultProfile("desktop").retention, ...overrides };
}

/** Everything off, so a test enables exactly the rules it is about. */
export function noRules(overrides: Partial<RetentionSettings> = {}): RetentionSettings {
  return retention({
    keepLast: 0,
    keepDays: 0,
    gfsEnabled: false,
    maxFolderMb: 0,
    ...overrides,
  });
}

export interface EntrySpec {
  id: string;
  /** Milliseconds before NOW. */
  age: number;
  type?: "full" | "diff";
  baseId?: string | null;
  status?: BackupStatus;
  pinned?: boolean;
  size?: number;
}

export function entry(spec: EntrySpec): BackupEntry {
  const type = spec.type ?? "full";
  return {
    id: spec.id,
    type,
    baseId: type === "full" ? null : (spec.baseId ?? null),
    createdAt: NOW - spec.age,
    status: spec.status ?? "ok",
    pinned: spec.pinned ?? false,
    size: spec.size ?? 1000,
    folder: spec.id,
  };
}

export function indexOf(...specs: EntrySpec[]): BackupIndex {
  return { schemaVersion: 1, backups: specs.map(entry) };
}

export const prunedIds = (plan: { prune: BackupEntry[] }): string[] =>
  plan.prune.map((b) => b.id).sort();
