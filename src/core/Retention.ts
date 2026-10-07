import type { BackupEntry, BackupIndex, RetentionSettings } from "../types";
import { chainFor, countsTowardRetention, sortedBackups } from "./BackupIndex";
import { rulesFor, type KeepReason, type RuleResult } from "./RetentionRules";
import { enforceSizeCap } from "./RetentionSize";

export type { KeepReason } from "./RetentionRules";

export interface RetentionPlan {
  /** Backups to delete. Always intact (status ok) and never a dependency of a kept backup. */
  prune: BackupEntry[];
  /** Every other backup with the reasons it stays. */
  keep: Map<string, KeepReason[]>;
  /** True when the max-folder-size cap could not be met without breaking a protection. */
  sizeCapUnmet: boolean;
}

function addReason(keep: Map<string, KeepReason[]>, id: string, reason: KeepReason): void {
  const list = keep.get(id);
  if (!list) keep.set(id, [reason]);
  else if (!list.includes(reason)) list.push(reason);
}

/**
 * Decide what to prune. Pure: reads the index, returns a plan, writes nothing.
 *
 * Policy rules (keep last N, keep N days, GFS) each name backups to keep; a backup stays if any
 * enabled rule keeps it, and with no rule enabled nothing is pruned by policy. On top of that:
 * 1. The newest intact backup is never pruned, so there is always a last good backup.
 * 2. Corrupt, partial and in-progress backups are never pruned automatically. They do not count
 *    toward any limit (see `countsTowardRetention`), and the user decides what to do with them.
 * 3. Pinned backups are never pruned (when `pinnedExempt` is on).
 * 4. Every kept backup keeps its whole restore chain. A differential backup is built on the
 *    one before it, so restoring it needs the full base AND every earlier diff; none of those
 *    may be pruned while a kept backup depends on them.
 * 5. Finally the max folder size cap removes the oldest removable backups (with their
 *    dependents), but never anything protected by rules 1-3.
 */
export function planRetention(
  index: BackupIndex,
  settings: RetentionSettings,
  now: number,
): RetentionPlan {
  const all = sortedBackups(index);
  const intact = all.filter(countsTowardRetention);
  const keep = new Map<string, KeepReason[]>();

  const enabled = rulesFor(settings)
    .map((rule) => rule(intact, now))
    .filter((r): r is RuleResult => r !== null);
  if (enabled.length === 0) {
    for (const b of intact) addReason(keep, b.id, "no-policy");
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

  const sizeCapUnmet = enforceSizeCap(index, keep, settings.maxFolderMb);
  return { prune: all.filter((b) => !keep.has(b.id)), keep, sizeCapUnmet };
}
