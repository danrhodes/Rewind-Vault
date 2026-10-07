import { BrokenChainError, ManifestError } from "../helpers/errors";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupEntry, BackupIndex, Manifest, ManifestEntry } from "../types";
import { chainFor, findBackup } from "./BackupIndex";
import { loadManifest } from "./Manifest";

/** Which backup to restore: a specific one, or whatever was newest at a moment in time. */
export type RestoreSource = { id: string } | { at: number };

export interface ChainLink {
  backup: BackupEntry;
  manifest: Manifest;
}

export interface ResolvedFile {
  path: string;
  /** The manifest entry holding this file's latest version at the chosen point. */
  entry: ManifestEntry;
  /** Backup that stores it, and that backup's folder inside the backup folder. */
  backupId: string;
  folder: string;
}

export interface ResolvedChain {
  target: BackupEntry;
  /** Base full backup first, then diffs oldest to newest, ending with the target. */
  links: ChainLink[];
  /** Every file that exists at the chosen point, and where to read it from. */
  files: Map<string, ResolvedFile>;
  /** Paths removed by a tombstone and not re-added since: what "recover deleted files" lists. */
  deletedPaths: Map<string, { deletedAt: number; lastBackupId: string }>;
}

function pickTarget(index: BackupIndex, source: RestoreSource): BackupEntry {
  if ("id" in source) {
    const found = findBackup(index, source.id);
    if (!found) throw new BrokenChainError(`Backup "${source.id}" is not in the backup index`);
    return found;
  }
  const candidates = index.backups
    .filter((b) => b.status === "ok" && b.createdAt <= source.at)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const best = candidates[0];
  if (!best) throw new BrokenChainError("There is no intact backup at or before that time");
  return best;
}

/**
 * Work out exactly which stored version of every file makes up the vault as it was at a
 * backup (or at a moment in time): start from the base full backup, apply each differential
 * in order, entries replacing older versions and tombstones removing files. Refuses to
 * proceed if any link is missing, damaged or inconsistent, because restoring from a partial
 * chain would silently produce a wrong vault.
 */
export async function resolveChain(
  store: IVaultStore,
  backupFolder: string,
  index: BackupIndex,
  source: RestoreSource,
): Promise<ResolvedChain> {
  const target = pickTarget(index, source);
  const chain = chainFor(index, target.id);
  if (!chain) {
    throw new BrokenChainError(
      `Backup "${target.id}" cannot be restored: the full backup it builds on is missing from the index`,
    );
  }

  const base = chain[0] as BackupEntry;
  const links: ChainLink[] = [];
  for (const backup of chain) {
    if (backup.status !== "ok") {
      throw new BrokenChainError(
        `Backup "${backup.id}" is marked ${backup.status}, so "${target.id}" cannot be restored from it`,
      );
    }
    links.push({ backup, manifest: await loadLinkManifest(store, backupFolder, backup, base) });
  }

  const files = new Map<string, ResolvedFile>();
  const deletedPaths = new Map<string, { deletedAt: number; lastBackupId: string }>();
  for (const { backup, manifest } of links) {
    if (manifest.type === "full") {
      files.clear();
      deletedPaths.clear();
    }
    for (const t of manifest.tombstones) {
      const previous = files.get(t.path);
      files.delete(t.path);
      deletedPaths.set(t.path, {
        deletedAt: t.deletedAt,
        lastBackupId: previous?.backupId ?? backup.id,
      });
    }
    for (const entry of manifest.entries) {
      files.set(entry.path, {
        path: entry.path,
        entry,
        backupId: backup.id,
        folder: backup.folder,
      });
      deletedPaths.delete(entry.path);
    }
  }
  return { target, links, files, deletedPaths };
}

async function loadLinkManifest(
  store: IVaultStore,
  backupFolder: string,
  backup: BackupEntry,
  base: BackupEntry,
): Promise<Manifest> {
  let manifest: Manifest;
  try {
    manifest = await loadManifest(store, `${backupFolder}/${backup.folder}`);
  } catch (cause) {
    if (cause instanceof ManifestError) {
      throw new BrokenChainError(`Backup "${backup.id}" is missing or its manifest is damaged`, {
        cause,
      });
    }
    throw cause;
  }
  if (manifest.id !== backup.id || manifest.type !== backup.type) {
    throw new BrokenChainError(`Backup "${backup.id}": its manifest does not match the index`);
  }
  if (manifest.type === "diff" && manifest.baseId !== base.id) {
    throw new BrokenChainError(
      `Backup "${backup.id}" was built on "${manifest.baseId}", not on "${base.id}"`,
    );
  }
  return manifest;
}
