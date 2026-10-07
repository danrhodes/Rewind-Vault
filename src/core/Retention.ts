import type { BackupEntry, BackupIndex, RetentionSettings } from "../types";
import { chainFor, countsTowardRetention, sortedBackups } from "./BackupIndex";

/** Why a backup is being kept. Shown to the user and asserted in tests. */
export type KeepReason =
  "no-policy" | "keep-last" | "newest-intact" | "pinned" | "not-intact" | "chain-dependency";

export interface RetentionPlan {
  /** Backups to delete. Always intact (status ok) and never a dependency of a kept backup. */
  prune: BackupEntry[];
  /** Every other backup with the reasons it stays. */
  keep: Map<string, KeepReason[]>;
}

interface RuleResult {
  reason: KeepReason;
  ids: Set<string>;
}

/**
 * A policy rule looks at the intact backups (newest first) and returns the ids it wants kept,
 * or null when the rule is switched off. Backups are kept if ANY enabled rule keeps them; if
 * every rule is off nothing is ever pruned.
 */
type Rule = (intactNewestFirst: BackupEntry[], now: number) => RuleResult | null;

/** Keep the newest N intact backups. 0 switches the rule off. */
const keepLastRule =
  (settings: RetentionSettings): Rule =>
  (intact) => {
    const n = Math.floor(settings.keepLast);
    if (!(n > 0)) return null;
    return { reason: "keep-last", ids: new Set(intact.slice(0, n).map((b) => b.id)) };
  };

function rulesFor(settings: RetentionSettings): Rule[] {
  return [keepLastRule(settings)];
}

function addReason(keep: Map<string, KeepReason[]>, id: string, reason: KeepReason): void {
  const list = keep.get(id);
  if (!list) keep.set(id, [reason]);
  else if (!list.includes(reason)) list.push(reason);
}

/**
 * Decide what to prune. Pure: reads the index, returns a plan, writes nothing.
 *
 * Safety rules, applied on top of whatever the policy says:
 * 1. The newest intact backup is never pruned, so there is always a last good backup.
 * 2. Corrupt, partial and in-progress backups are never pruned automatically. They do not count
 *    toward any limit (see `countsTowardRetention`), and the user decides what to do with them.
 * 3. Pinned backups are never pruned (when `pinnedExempt` is on).
 * 4. Every kept backup keeps its whole restore chain. A differential backup is built on the
 *    one before it, so restoring it needs the full base AND every earlier diff; none of those
 *    may be pruned while a kept backup depends on them.
 */
export function planRetention(
  index: BackupIndex,
  settings: RetentionSettings,
  now: number,
): RetentionPlan {
  const all = sortedBackups(index);
  const intact = all.filter(countsTowardRetention);
  const keep = new Map<string, KeepReason[]>();

  const results = rulesFor(settings).map((rule) => rule(intact, now));
  const enabled = results.filter((r): r is RuleResult => r !== null);
  if (enabled.length === 0) {
    for (const b of all) addReason(keep, b.id, "no-policy");
    return { prune: [], keep };
  }
  for (const { reason, ids } of enabled) {
    for (const id of ids) addReason(keep, id, reason);
  }

  if (intact[0]) addReason(keep, intact[0].id, "newest-intact");
  for (const b of all) {
    if (!countsTowardRetention(b)) addReason(keep, b.id, "not-intact");
    else if (b.pinned && settings.pinnedExempt) addReason(keep, b.id, "pinned");
  }

  // Close over restore chains. Snapshot the ids first: the loop adds to `keep`.
  for (const id of [...keep.keys()]) {
    for (const link of chainFor(index, id) ?? []) {
      if (link.id !== id && !keep.has(link.id)) addReason(keep, link.id, "chain-dependency");
    }
  }

  return { prune: all.filter((b) => !keep.has(b.id)), keep };
}
