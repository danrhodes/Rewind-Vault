import { RestoreError } from "../helpers/errors";
import { isSafeRelPath } from "../helpers/validate";
import type { IVaultStore } from "../storage/VaultStore";
import { loadIndex } from "./BackupIndex";
import { loadManifest } from "./Manifest";

/** One distinct state of a file across the backup history. */
export interface FileVersion {
  /** The backup that first recorded this state; restore it with `{ id: backupId }`. */
  backupId: string;
  createdAt: number;
  kind: "present" | "deleted";
  /** Content details; absent for `deleted`. */
  size?: number;
  mtime?: number;
  sha256?: string;
}

/**
 * Every distinct version of one file across all intact backups, oldest first. A new version
 * appears when the content changes or the file is deleted (tombstone, or absent from a later
 * full backup); unchanged copies in later backups are not repeated. Backups that are not
 * intact are skipped, as are ones whose manifest cannot be read. An unknown file gives [].
 */
export async function listFileVersions(
  store: IVaultStore,
  backupFolder: string,
  path: string,
): Promise<FileVersion[]> {
  const clean = path.replace(/\/+$/, "");
  if (!isSafeRelPath(clean)) throw new RestoreError(`"${path}" is not a valid vault path`);

  const index = await loadIndex(store, backupFolder);
  const backups = index.backups
    .filter((b) => b.status === "ok")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

  const versions: FileVersion[] = [];
  for (const backup of backups) {
    let manifest;
    try {
      manifest = await loadManifest(store, `${backupFolder}/${backup.folder}`);
    } catch {
      continue;
    }
    const last = versions[versions.length - 1];
    const present = last !== undefined && last.kind === "present";
    const entry = manifest.entries.find((e) => e.path === clean);
    if (entry) {
      if (!present || last.sha256 !== entry.sha256) {
        versions.push({
          backupId: backup.id,
          createdAt: backup.createdAt,
          kind: "present",
          size: entry.size,
          mtime: entry.mtime,
          sha256: entry.sha256,
        });
      }
    } else if (present) {
      const tombstoned = manifest.tombstones.some((t) => t.path === clean);
      if (tombstoned || manifest.type === "full") {
        versions.push({ backupId: backup.id, createdAt: backup.createdAt, kind: "deleted" });
      }
    }
  }
  return versions;
}
