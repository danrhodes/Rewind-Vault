import type { BackupEntry, RetentionSettings } from "../types";

/** Why a backup is being kept. Shown to the user and asserted in tests. */
export type KeepReason =
  | "no-policy"
  | "keep-last"
  | "keep-days"
  | "gfs"
  | "newest-intact"
  | "pinned"
  | "not-intact"
  | "chain-dependency";

export interface RuleResult {
  reason: KeepReason;
  ids: Set<string>;
}

/**
 * A policy rule looks at the intact backups (newest first) and returns the ids it wants kept,
 * or null when the rule is switched off. Backups are kept if ANY enabled rule keeps them; if
 * every rule is off nothing is pruned by policy.
 */
export type Rule = (intactNewestFirst: BackupEntry[], now: number) => RuleResult | null;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep the newest N intact backups. 0 switches the rule off. */
const keepLastRule =
  (settings: RetentionSettings): Rule =>
  (intact) => {
    const n = Math.floor(settings.keepLast);
    if (!(n > 0)) return null;
    return { reason: "keep-last", ids: new Set(intact.slice(0, n).map((b) => b.id)) };
  };

/** Keep intact backups made within the last N days (a backup exactly N days old stays). 0 = off. */
const keepDaysRule =
  (settings: RetentionSettings): Rule =>
  (intact, now) => {
    const days = settings.keepDays;
    if (!(days > 0)) return null;
    const cutoff = now - days * DAY_MS;
    return {
      reason: "keep-days",
      ids: new Set(intact.filter((b) => b.createdAt >= cutoff).map((b) => b.id)),
    };
  };

/** Calendar buckets in UTC (folder names are UTC too). Weeks start on Monday. */
const dayKey = (ms: number): number => Math.floor(ms / DAY_MS);
// 1970-01-01 was a Thursday, so shifting by 3 days aligns week boundaries to Monday.
const weekKey = (ms: number): number => Math.floor((dayKey(ms) + 3) / 7);
const monthKey = (ms: number): number => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/** The newest backup of each of the `count` most recent buckets that contain any backup. */
function newestPerBucket(
  intact: BackupEntry[],
  count: number,
  key: (ms: number) => number,
): string[] {
  const n = Math.floor(count);
  if (!(n > 0)) return [];
  const seen = new Set<number>();
  const ids: string[] = [];
  for (const b of intact) {
    const k = key(b.createdAt);
    if (seen.has(k)) continue;
    if (seen.size >= n) break;
    seen.add(k);
    ids.push(b.id);
  }
  return ids;
}

/**
 * Grandfather-father-son: keep the newest backup of each of the last D days, W weeks and M
 * months. As in restic keep-daily, "last D days" means the D most recent days THAT HAVE a
 * backup, so a holiday gap does not wipe out history.
 */
const gfsRule =
  (settings: RetentionSettings): Rule =>
  (intact) => {
    if (!settings.gfsEnabled) return null;
    if (settings.gfsDaily <= 0 && settings.gfsWeekly <= 0 && settings.gfsMonthly <= 0) return null;
    const ids = new Set([
      ...newestPerBucket(intact, settings.gfsDaily, dayKey),
      ...newestPerBucket(intact, settings.gfsWeekly, weekKey),
      ...newestPerBucket(intact, settings.gfsMonthly, monthKey),
    ]);
    return { reason: "gfs", ids };
  };

export function rulesFor(settings: RetentionSettings): Rule[] {
  return [keepLastRule(settings), keepDaysRule(settings), gfsRule(settings)];
}
