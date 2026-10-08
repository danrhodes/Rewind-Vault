import { isSafeRelPath } from "../helpers/validate";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { formatBytes } from "../helpers/format";
import { writeText, type IVaultStore } from "../storage/VaultStore";
import type { BackupIndex, ManifestVerify, SettingsProfile } from "../types";
import { loadIndex, sortedBackups } from "./BackupIndex";
import { loadDeepVerifyRecord, type DeepVerifyRecord } from "./DeepVerify";
import { loadManifest } from "./Manifest";
import { loadRehearsalRecord, type RehearsalRecord } from "./ScheduledRehearsal";

export const STATUS_NOTE_NAME = "Backup Status.md";
/** A newest good backup older than this makes the status a warning. */
export const STALE_AFTER_DAYS = 3;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TABLE_ROWS = 10;

export type HealthStatus = "none" | "ok" | "warning" | "error";

export interface StatusData {
  index: BackupIndex;
  /** Last verification recorded on the newest backup, if any. */
  lastVerify: ManifestVerify | null;
  deepVerify: DeepVerifyRecord | null;
  rehearsal?: RehearsalRecord | null;
  now: number;
}

/** Where the note lives: the configured path, or `Backup Status.md` in the backup folder. */
export function statusNotePath(profile: SettingsProfile): string {
  const custom = profile.notifications.statusNotePath.trim();
  return custom === "" ? `${profile.destination.backupFolder}/${STATUS_NOTE_NAME}` : custom;
}

/**
 * error: nothing restorable, or the newest backup is damaged.
 * warning: the newest good backup is old, any backup is damaged, or the last check failed.
 */
export function healthOf(data: StatusData): { status: HealthStatus; reasons: string[] } {
  const backups = sortedBackups(data.index);
  if (backups.length === 0) return { status: "none", reasons: ["No backup has been made yet."] };
  const reasons: string[] = [];
  const newest = backups[0];
  const newestOk = backups.find((b) => b.status === "ok");
  let status: HealthStatus = "ok";
  if (!newestOk) {
    status = "error";
    reasons.push("No intact backup exists.");
  } else if (newest && newest.status !== "ok") {
    status = "error";
    reasons.push(`The newest backup is marked ${newest.status}.`);
  }
  const damaged = backups.filter((b) => b.status !== "ok").length;
  if (damaged > 0 && status === "ok") status = "warning";
  if (damaged > 0 && status !== "error") reasons.push(`${damaged} backup(s) are damaged.`);
  if (newestOk && data.now - newestOk.createdAt > STALE_AFTER_DAYS * DAY_MS) {
    if (status === "ok") status = "warning";
    reasons.push(`The newest good backup is more than ${STALE_AFTER_DAYS} days old.`);
  }
  if (
    data.lastVerify?.result === "fail" ||
    data.deepVerify?.result === "fail" ||
    data.rehearsal?.result === "fail"
  ) {
    if (status === "ok") status = "warning";
    reasons.push("The last verification failed.");
  }
  return { status, reasons };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const q = (text: string): string => JSON.stringify(text);

/** The note: YAML properties (Dataview and Bases read them) plus a short readable table. */
export function renderStatusNote(data: StatusData): string {
  const { status, reasons } = healthOf(data);
  const backups = sortedBackups(data.index);
  const newest = backups[0];
  const newestOk = backups.find((b) => b.status === "ok");
  const size = backups.reduce((n, b) => n + b.size, 0);
  const fm: string[] = [
    "rewind_vault_status: true",
    `status: ${status}`,
    `updated: ${q(iso(data.now))}`,
    `backups_total: ${backups.length}`,
    `backups_ok: ${backups.filter((b) => b.status === "ok").length}`,
    `backups_damaged: ${backups.filter((b) => b.status !== "ok").length}`,
    `backups_pinned: ${backups.filter((b) => b.pinned).length}`,
    `total_size_bytes: ${size}`,
  ];
  if (newest) {
    fm.push(
      `last_backup: ${q(iso(newest.createdAt))}`,
      `last_backup_id: ${q(newest.id)}`,
      `last_backup_type: ${newest.type}`,
      `last_backup_status: ${newest.status}`,
      `last_backup_age_hours: ${Math.round(((data.now - newest.createdAt) / HOUR_MS) * 10) / 10}`,
    );
  }
  if (newestOk) fm.push(`last_good_backup: ${q(iso(newestOk.createdAt))}`);
  if (data.lastVerify) {
    fm.push(
      `last_verify: ${q(iso(data.lastVerify.lastAt))}`,
      `last_verify_level: ${data.lastVerify.lastLevel}`,
      `last_verify_result: ${data.lastVerify.result}`,
    );
  }
  if (data.deepVerify) {
    fm.push(
      `last_deep_verify: ${q(iso(data.deepVerify.lastRunAt))}`,
      `last_deep_verify_result: ${data.deepVerify.result}`,
    );
  }

  if (data.rehearsal) {
    fm.push(
      `last_rehearsal: ${q(iso(data.rehearsal.lastRunAt))}`,
      `last_rehearsal_result: ${data.rehearsal.result}`,
    );
  }

  const lines = [
    "---",
    ...fm,
    "---",
    "",
    "# Backup status",
    "",
    `**${status.toUpperCase()}**${reasons.length > 0 ? `: ${reasons.join(" ")}` : ""}`,
    "",
    "_Written by Rewind Vault. This note is replaced after every backup; do not edit it._",
  ];
  if (backups.length > 0) {
    lines.push("", "| Backup | Type | Status | Size | Pinned |", "| --- | --- | --- | --- | --- |");
    for (const b of backups.slice(0, TABLE_ROWS)) {
      const name = b.label ? `${b.id} (${b.label.replace(/\|/g, "/")})` : b.id;
      lines.push(
        `| ${name} | ${b.type} | ${b.status} | ${formatBytes(b.size)} | ${b.pinned ? "yes" : ""} |`,
      );
    }
    if (backups.length > TABLE_ROWS)
      lines.push("", `…and ${backups.length - TABLE_ROWS} older backups.`);
  }
  return lines.join("\n") + "\n";
}

export interface StatusNoteDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
}

/**
 * Write the status note if the setting is on. Never throws (a status note must not break a
 * backup). Returns whether it wrote. A configured path that is not a safe `.md` path is
 * refused with a warning.
 */
export async function updateStatusNote(deps: StatusNoteDeps): Promise<boolean> {
  const profile = deps.getProfile();
  if (!profile.notifications.statusNote) return false;
  const path = statusNotePath(profile);
  if (!path.endsWith(".md") || !isSafeRelPath(path)) {
    deps.logger.warn(`Status note skipped: "${path}" is not a valid note path`);
    return false;
  }
  try {
    const folder = profile.destination.backupFolder;
    const index = await loadIndex(deps.store, folder);
    const newest = sortedBackups(index)[0];
    let lastVerify: ManifestVerify | null = null;
    if (newest) {
      lastVerify = await loadManifest(deps.store, `${folder}/${newest.folder}`)
        .then((m) => m.verify ?? null)
        .catch(() => null);
    }
    const deepVerify = await loadDeepVerifyRecord(deps, folder);
    const rehearsal = await loadRehearsalRecord(deps, folder);
    await writeText(
      deps.store,
      path,
      renderStatusNote({ index, lastVerify, deepVerify, rehearsal, now: deps.clock.now() }),
    );
    return true;
  } catch (error) {
    deps.logger.warn(
      `Could not update the status note: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
