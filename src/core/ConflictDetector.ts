export interface ConflictFile {
  path: string;
  /** The file this is probably a copy of, with the sync tool's marker removed. */
  original: string;
  /** Whether that original is in the vault too (then it is a real duplicate to resolve). */
  originalExists: boolean;
}

/**
 * How sync tools name the extra copy they make when two devices edit one file:
 *  - Dropbox, Obsidian Sync, Nextcloud, Resilio: `Note (conflicted copy 2026-10-08).md`,
 *    `Note (Dan's conflicted copy 2026-10-08).md`
 *  - Syncthing: `Note.sync-conflict-20261008-101500-ABCDEFG.md`
 *  - Nextcloud (older): `Note_conflict-20261008-101500.md`
 *  - Seafile: `Note (SFConflict dan@x 2026-10-08).md`
 *  - Dropbox: `Note (Case Conflict).md`
 * Only the file name is checked, never folder names. Names that merely contain the word
 * "conflict" ("Conflict resolution.md") do not match. Services that number copies
 * ("Note (1).md", "Note 2.md") or add a device name cannot be told apart from ordinary names,
 * so they are not flagged.
 */
const MARKERS: readonly RegExp[] = [
  /\s*\([^()]*conflicted copy[^()]*\)/i,
  /\s*\(SFConflict[^()]*\)/i,
  /\s*\(case conflict[^()]*\)/i,
  /\.sync-conflict-\d{8}-\d{6}(-[A-Z0-9]+)?/i,
  /_conflict-\d{8}-\d{6}/i,
];

function splitName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** True when the file name carries a sync tool's conflict marker. */
export function isConflictPath(path: string): boolean {
  const { name } = splitName(path);
  return MARKERS.some((marker) => marker.test(name));
}

/** The path with every conflict marker removed. */
export function originalPathOf(path: string): string {
  const { dir, name } = splitName(path);
  let clean = name;
  for (const marker of MARKERS) clean = clean.replace(marker, "");
  return dir + clean;
}

/** Conflict copies among `paths`, sorted by path. */
export function findConflictFiles(paths: readonly string[]): ConflictFile[] {
  const all = new Set(paths);
  return paths
    .filter(isConflictPath)
    .sort()
    .map((path) => {
      const original = originalPathOf(path);
      return { path, original, originalExists: all.has(original) };
    });
}
