import { createGlobMatcher, isHiddenPath, isInsideFolder } from "../helpers/glob";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { FileInfo, SettingsProfile } from "../types";

export interface ScanOptions {
  /** Always excluded, whatever the other options say. */
  backupFolder: string;
  includeHidden: boolean;
  excludeHidden: boolean;
  excludeObsidian: boolean;
  excludeGit: boolean;
  excludeNodeModules: boolean;
  excludeTrash: boolean;
  /** Gitignore-style patterns (see helpers/glob). */
  globs: readonly string[];
}

export function scanOptionsFromProfile(profile: SettingsProfile): ScanOptions {
  return {
    backupFolder: profile.destination.backupFolder,
    includeHidden: profile.basic.includeHidden,
    excludeHidden: profile.exclusions.excludeHidden,
    excludeObsidian: profile.exclusions.excludeObsidian,
    excludeGit: profile.exclusions.excludeGit,
    excludeNodeModules: profile.exclusions.excludeNodeModules,
    excludeTrash: profile.exclusions.excludeTrash,
    globs: profile.exclusions.globs,
  };
}

export type ExcludeCheck = (path: string) => boolean;

/**
 * Builds the exclusion test for a vault-relative path. Hidden paths (any segment starting
 * with ".") are kept only when includeHidden is on and excludeHidden is off. The named
 * folders below are removed even when hidden files are otherwise included. A pattern that
 * matches a folder removes everything inside it; negations cannot rescue files from an
 * excluded folder (same as gitignore).
 */
export function createExcludeCheck(options: ScanOptions): ExcludeCheck {
  const matchesGlob = createGlobMatcher(options.globs);
  const hiddenAllowed = options.includeHidden && !options.excludeHidden;

  return (path) => {
    if (options.backupFolder !== "" && isInsideFolder(path, options.backupFolder)) return true;
    if (!hiddenAllowed && isHiddenPath(path)) return true;
    if (options.excludeObsidian && isInsideFolder(path, ".obsidian")) return true;
    if (options.excludeTrash && isInsideFolder(path, ".trash")) return true;
    if (options.excludeGit && hasSegment(path, ".git")) return true;
    if (options.excludeNodeModules && hasSegment(path, "node_modules")) return true;
    return matchesGlob(path);
  };
}

function hasSegment(path: string, name: string): boolean {
  return path.split("/").includes(name);
}

/**
 * Walk the vault and return every file that is not excluded, sorted by path. Excluded
 * folders are skipped without being listed, so a large `node_modules` costs nothing.
 */
export async function scanVault(
  store: IVaultStore,
  options: ScanOptions,
  yieldIfNeeded: () => Promise<void> = createYielder(),
): Promise<FileInfo[]> {
  const isExcluded = createExcludeCheck(options);
  const files: FileInfo[] = [];
  const pending: string[] = [""];

  while (pending.length > 0) {
    const folder = pending.pop() as string;
    const listing = await store.list(folder);

    for (const sub of listing.folders) {
      if (!isExcluded(sub)) pending.push(sub);
    }
    for (const path of listing.files) {
      if (isExcluded(path)) continue;
      const stat = await store.stat(path);
      if (stat?.type === "file") files.push({ path, size: stat.size, mtime: stat.mtime });
    }
    await yieldIfNeeded();
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
