import type { FileVersion } from "../core/FileVersions";
import { formatBytes } from "../helpers/format";

export interface VersionRow {
  backupId: string;
  kind: "present" | "deleted";
  title: string;
  detail: string;
  /** Same content as the file in the vault now. */
  isCurrent: boolean;
}

/**
 * Version rows for the time machine, newest first. `currentSha` is the SHA-256 of the file in
 * the vault now (null when it does not exist), so the version that matches it can be marked.
 */
export function buildVersionRows(
  versions: readonly FileVersion[],
  currentSha: string | null,
  format: (ms: number) => string,
): VersionRow[] {
  return [...versions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((v): VersionRow => {
      const isCurrent = v.kind === "present" && currentSha !== null && v.sha256 === currentSha;
      if (v.kind === "deleted") {
        return {
          backupId: v.backupId,
          kind: "deleted",
          title: format(v.createdAt),
          detail: "File deleted at this point",
          isCurrent: false,
        };
      }
      const size = v.size === undefined ? "" : formatBytes(v.size);
      return {
        backupId: v.backupId,
        kind: "present",
        title: format(v.createdAt),
        detail: [size, isCurrent ? "same as now" : ""].filter(Boolean).join(", "),
        isCurrent,
      };
    });
}

export function describeTimeline(path: string, rows: readonly VersionRow[]): string {
  const versions = rows.filter((r) => r.kind === "present").length;
  if (rows.length === 0) return `${path} is not in any backup yet.`;
  return `${path}: ${versions} saved version${versions === 1 ? "" : "s"}, newest first.`;
}
