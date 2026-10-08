import type { DeletedFile } from "../core/RestoreEngine";

/** Deleted files whose path contains the query (case-insensitive). An empty query keeps all. */
export function filterDeleted(files: readonly DeletedFile[], query: string): DeletedFile[] {
  const q = query.trim().toLowerCase();
  return q === "" ? [...files] : files.filter((f) => f.path.toLowerCase().includes(q));
}

/**
 * Chosen paths grouped by the backup that holds their last version, in the order the backups
 * first appear. Paths that are not in `files` are ignored.
 */
export function groupByBackup(
  files: readonly DeletedFile[],
  chosen: ReadonlySet<string>,
): { backupId: string; paths: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    if (!chosen.has(file.path)) continue;
    const list = groups.get(file.lastBackupId) ?? [];
    list.push(file.path);
    groups.set(file.lastBackupId, list);
  }
  return [...groups].map(([backupId, paths]) => ({ backupId, paths }));
}

export function describeDeleted(shown: number, total: number, selected: number): string {
  if (total === 0)
    return "No deleted files to recover: everything the backups know is in your vault.";
  const base =
    shown === total ? `${total} deleted file(s)` : `${shown} of ${total} deleted file(s)`;
  return `${base}, ${selected} selected.`;
}
