import type { DeleteImpact } from "../core/BackupAdmin";
import { sortedBackups } from "../core/BackupIndex";
import { formatBytes } from "../helpers/format";
import type { BackupEntry, BackupIndex, BackupStatus } from "../types";

export interface BackupRow {
  id: string;
  /** "2026-10-07 21:24" plus the milestone label when there is one. */
  title: string;
  /** "Full, 12.4 MB". */
  subtitle: string;
  /** Short tags shown next to the title: "pinned", "corrupt", ... */
  badges: string[];
  status: BackupStatus;
  pinned: boolean;
  type: "full" | "diff";
}

export type DateFormatter = (ms: number) => string;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local time, "2026-10-07 21:24". Injected in tests so they do not depend on the time zone. */
export const formatLocalDateTime: DateFormatter = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const TYPE_NAME = { full: "Full", diff: "Differential" } as const;

const STATUS_BADGE: Record<BackupStatus, string | null> = {
  ok: null,
  corrupt: "corrupt",
  partial: "incomplete",
  "in-progress": "in progress",
};

export function rowFor(entry: BackupEntry, format: DateFormatter): BackupRow {
  const badges: string[] = [];
  if (entry.pinned) badges.push("pinned");
  const status = STATUS_BADGE[entry.status];
  if (status) badges.push(status);
  const when = format(entry.createdAt);
  return {
    id: entry.id,
    title: entry.label ? `${when}  ${entry.label}` : when,
    subtitle: `${TYPE_NAME[entry.type]}, ${formatBytes(entry.size)}`,
    badges,
    status: entry.status,
    pinned: entry.pinned,
    type: entry.type,
  };
}

/** Everything a user might type to find a backup: date, label, type, status, pinned, id. */
function haystack(entry: BackupEntry, row: BackupRow): string {
  return [
    entry.id,
    row.title,
    TYPE_NAME[entry.type],
    entry.type === "diff" ? "diff" : "",
    entry.status,
    ...row.badges,
  ]
    .join(" ")
    .toLowerCase();
}

/** Newest first. Every word of the query must appear somewhere (case-insensitive). */
export function buildRows(
  index: BackupIndex,
  query: string,
  format: DateFormatter = formatLocalDateTime,
): BackupRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: BackupRow[] = [];
  for (const entry of sortedBackups(index)) {
    const row = rowFor(entry, format);
    if (words.every((w) => haystack(entry, row).includes(w))) rows.push(row);
  }
  return rows;
}

export function summarize(index: BackupIndex): string {
  const count = index.backups.length;
  if (count === 0) return "No backups yet.";
  const total = index.backups.reduce((sum, b) => sum + b.size, 0);
  return `${count} backup${count === 1 ? "" : "s"}, ${formatBytes(total)} in total.`;
}

export interface DeletePrompt {
  /** The question to put in the confirmation dialog. */
  message: string;
  /** Pass `cascade: true` to the delete when this is set. */
  cascade: boolean;
  /** Pass `force: true` to the delete when this is set. */
  force: boolean;
}

/** Spell out what a deletion would cost, so the confirmation is an informed one. */
export function describeDelete(impact: DeleteImpact, format: DateFormatter): DeletePrompt {
  const when = format(impact.entry.createdAt);
  const lines = [`Delete the backup from ${when}? This cannot be undone.`];
  const n = impact.dependents.length;
  if (n > 0) {
    lines.push(
      `${n} newer differential backup${n === 1 ? "" : "s"} cannot be restored without it and will be deleted too.`,
    );
  }
  if (impact.pinned) lines.push("A pinned milestone is among them.");
  if (impact.lastIntact)
    lines.push("This is your only intact backup. You would have nothing to restore from.");
  return { message: lines.join("\n\n"), cascade: n > 0, force: impact.pinned };
}
