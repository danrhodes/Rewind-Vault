import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { isSafeRelPath } from "../helpers/validate";
import type { ITextAppender } from "../storage/TextAppender";
import type { NotificationSettings } from "../types";

/** The same message is written at most once per this long, so a failing schedule cannot flood the note. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:mm". */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Writes backup failures into a note as unchecked tasks, so a failure shows up where the user
 * already looks (setting: notifications.dailyNoteFailureAppend and dailyNotePath). It works
 * whatever the notification level, because its purpose is that a failure is not missed. It
 * never throws: an alert that fails is logged and dropped, so it cannot hide the real error.
 */
export class FailureAlert {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly appender: ITextAppender,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly settings: () => NotificationSettings,
  ) {}

  /** Fire and forget; resolves when the write is done (for tests). */
  async report(message: string): Promise<void> {
    const { dailyNoteFailureAppend, dailyNotePath } = this.settings();
    if (!dailyNoteFailureAppend) return;
    const path = dailyNotePath.trim();
    if (!path.endsWith(".md") || !isSafeRelPath(path)) {
      this.logger.warn(`Failure alert skipped: "${dailyNotePath}" is not a valid note path`);
      return;
    }
    const now = this.clock.now();
    for (const [text, at] of this.recent) {
      if (now - at >= DUPLICATE_WINDOW_MS) this.recent.delete(text);
    }
    if (this.recent.has(message)) return;
    this.recent.set(message, now);
    const line = `\n- [ ] ${localStamp(now)} Rewind Vault: ${message.replace(/\s+/g, " ").trim()}\n`;
    try {
      await this.appender.appendText(path, line);
    } catch (error) {
      this.logger.warn(
        `Could not write the failure alert to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
