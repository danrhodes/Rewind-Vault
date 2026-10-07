import type { BackupEntry, BackupIndex } from "../types";
import { chainFor, countsTowardRetention, sortedBackups } from "./BackupIndex";
import type { KeepReason } from "./RetentionRules";

const MB = 1024 * 1024;

/** Reasons that make a backup untouchable by the size cap (policy reasons it may override). */
const PROTECTED: readonly KeepReason[] = ["newest-intact", "pinned", "not-intact"];

const isProtected = (reasons: KeepReason[] | undefined): boolean =>
  (reasons ?? []).some((r) => PROTECTED.includes(r));

/**
 * Enforce `maxFolderMb`: while the kept backups exceed the cap, remove the OLDEST removable
 * one together with everything that depends on it (an old full takes its diffs with it, since
 * they cannot be restored without it). A candidate is skipped when it, or anything depending
 * on it, is the newest intact backup or pinned. Corrupt/partial backups are never removed, but
 * their size counts. The cap overrides keep-last/keep-days/GFS, never the protections.
 * Mutates `keep`. Returns true when the cap could not be met.
 */
export function enforceSizeCap(
  index: BackupIndex,
  keep: Map<string, KeepReason[]>,
  maxFolderMb: number,
): boolean {
  if (!(maxFolderMb > 0)) return false;
  const cap = maxFolderMb * MB;
  const byId = new Map(index.backups.map((b) => [b.id, b]));
  const total = (): number =>
    [...keep.keys()].reduce((sum, id) => sum + (byId.get(id)?.size ?? 0), 0);

  const oldestFirst = sortedBackups(index).reverse();
  for (const candidate of oldestFirst) {
    if (total() <= cap) return false;
    if (!keep.has(candidate.id) || !countsTowardRetention(candidate)) continue;
    if (isProtected(keep.get(candidate.id))) continue;

    const dependents = [...keep.keys()]
      .map((id) => byId.get(id))
      .filter((b): b is BackupEntry => b !== undefined && b.id !== candidate.id)
      .filter((b) => chainFor(index, b.id)?.some((link) => link.id === candidate.id));
    // Corrupt dependents are unrestorable anyway and are never deleted: they do not block.
    const removable = dependents.filter(countsTowardRetention);
    if (removable.some((b) => isProtected(keep.get(b.id)))) continue;

    keep.delete(candidate.id);
    for (const b of removable) keep.delete(b.id);
  }
  return total() > cap;
}
