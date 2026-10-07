import { BACKUP_FOLDER_SUFFIX } from "../constants";
import type { BackupType } from "../types";

export interface IClock {
  now(): number;
}

export const systemClock: IClock = { now: () => Date.now() };

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** UTC timestamp safe for folder names: `2026-10-07T21-24-00`. Sorts chronologically. */
export function folderTimestamp(ms: number): string {
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
  return `${date}T${time}`;
}

const FOLDER_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/;

/** Inverse of folderTimestamp. Returns null when the text is not in that format. */
export function parseFolderTimestamp(text: string): number | null {
  const m = FOLDER_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject overflowed dates such as month 13 or Feb 30.
  return folderTimestamp(ms) === text ? ms : null;
}

/** Backup folder name, e.g. `2026-10-07T21-24-00_full`. Also used as the backup id. */
export function backupFolderName(ms: number, type: BackupType): string {
  return `${folderTimestamp(ms)}_${BACKUP_FOLDER_SUFFIX[type]}`;
}

export function parseBackupFolderName(
  name: string,
): { createdAt: number; type: BackupType } | null {
  const i = name.lastIndexOf("_");
  if (i < 0) return null;
  const createdAt = parseFolderTimestamp(name.slice(0, i));
  const suffix = name.slice(i + 1);
  if (createdAt === null) return null;
  if (suffix === BACKUP_FOLDER_SUFFIX.full) return { createdAt, type: "full" };
  if (suffix === BACKUP_FOLDER_SUFFIX.diff) return { createdAt, type: "diff" };
  return null;
}

/** Parse "HH:MM" (24h) into minutes since midnight, or null if invalid. */
export function parseTimeOfDay(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}
