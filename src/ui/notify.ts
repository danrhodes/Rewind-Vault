import type { RunResult } from "../core/RunTypes";
import { formatBytes } from "../helpers/format";
import type { NotificationLevel, SettingsProfile } from "../types";

/** Shows a transient message. main.ts passes `(m, ms) => new Notice(m, ms)`. */
export type ShowNotice = (message: string, timeoutMs?: number) => void;

export type NoticeKind = "error" | "warning" | "info" | "success";

const ERROR_TIMEOUT_MS = 10_000;

/**
 * Which kinds each level lets through. `silent` shows nothing (everything is still in the log
 * file); `errors` shows failures and warnings that need attention; `verbose` also shows
 * progress-style information and successes.
 */
const VISIBLE: Record<NotificationLevel, readonly NoticeKind[]> = {
  silent: [],
  errors: ["error", "warning"],
  verbose: ["error", "warning", "info", "success"],
};

/** Receives every error message, whatever the notification level (see FailureAlert). */
export type ErrorSink = (message: string) => void;

/** Notices honouring the `notifications.level` setting, which is read on every call. */
export class Notifier {
  constructor(
    private readonly show: ShowNotice,
    private readonly getProfile: () => SettingsProfile,
    private readonly onError?: ErrorSink,
  ) {}

  /** True when a notice of this kind would be shown right now. */
  wouldShow(kind: NoticeKind): boolean {
    return VISIBLE[this.getProfile().notifications.level].includes(kind);
  }

  notify(kind: NoticeKind, message: string): void {
    if (kind === "error") {
      try {
        this.onError?.(message);
      } catch {
        // An alert that fails must never break the operation that reported the error.
      }
    }
    if (!this.wouldShow(kind)) return;
    try {
      this.show(`Rewind Vault: ${message}`, kind === "error" ? ERROR_TIMEOUT_MS : undefined);
    } catch {
      // A broken notice must never break a backup.
    }
  }

  error(message: string): void {
    this.notify("error", message);
  }

  warning(message: string): void {
    this.notify("warning", message);
  }

  info(message: string): void {
    this.notify("info", message);
  }

  success(message: string): void {
    this.notify("success", message);
  }

  /** Report the outcome of a backup run: success/skip, plus a failed verification. */
  backupResult(result: RunResult): void {
    if (result.status === "skipped") {
      this.info("No changes since the last backup, nothing to do.");
      return;
    }
    const files = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"}`;
    this.success(`Backup complete: ${files}, ${formatBytes(result.bytes)}.`);
    if (result.forcedFullReason) {
      // Info, not a warning: the very first backup is always promoted to a full one.
      this.info(`Made a full backup instead of a differential one: ${result.forcedFullReason}.`);
    }
    if (result.skippedFiles.length > 0) {
      this.warning(`${result.skippedFiles.length} file(s) were left out. See the log for details.`);
    }
    const conflicts = result.conflictFiles ?? [];
    if (conflicts.length > 0) {
      const first = conflicts[0]?.path ?? "";
      this.warning(
        `${conflicts.length} sync-conflict file(s) found in your vault (for example "${first}"). ` +
          "They were backed up as they are. Open them, keep what you need and delete the extra copy.",
      );
    }
    const check = result.verification;
    if (check?.result === "fail" && this.getProfile().verification.onFailureNotify) {
      this.error(
        `Backup ${result.backupId} FAILED verification (${check.issues.length} problem(s)). ` +
          "A new full backup will be made next time.",
      );
    }
  }

  /** Report an error thrown by an operation, naming what was being attempted. */
  failure(action: string, error: unknown): void {
    this.error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
