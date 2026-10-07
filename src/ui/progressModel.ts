import type { RunProgress } from "../core/RunTypes";
import type { RestoreProgress } from "../core/RestoreTypes";
import { formatBytes } from "../helpers/format";

/** What the progress dialog shows. Pure data, so it can be tested without Obsidian. */
export interface ProgressView {
  heading: string;
  /** "12 of 340 files, 1.2 MB of 8 MB". */
  detail: string;
  /** 0 to 1, or null when the total is not known yet (show an indeterminate bar). */
  fraction: number | null;
  currentFile?: string;
}

function fractionOf(done: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.min(1, Math.max(0, done / total));
}

function detailText(filesDone: number, filesTotal: number, bytesDone: number, bytesTotal: number) {
  if (filesTotal <= 0) return "";
  const files = `${filesDone} of ${filesTotal} file${filesTotal === 1 ? "" : "s"}`;
  return bytesTotal > 0
    ? `${files}, ${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`
    : files;
}

const withFile = (view: ProgressView, file: string | undefined): ProgressView =>
  file ? { ...view, currentFile: file } : view;

export function viewBackupProgress(p: RunProgress): ProgressView {
  switch (p.phase) {
    case "scanning":
      return { heading: "Scanning the vault…", detail: "", fraction: null };
    case "finalizing":
      return { heading: "Finishing the backup…", detail: "", fraction: 1 };
    case "verifying":
      return { heading: "Verifying the backup…", detail: "", fraction: null };
    case "packing": {
      const part = p.partCount > 1 ? ` (part ${p.partIndex} of ${p.partCount})` : "";
      const done = p.bytesTotal > 0 ? p.bytesDone : p.filesDone;
      const total = p.bytesTotal > 0 ? p.bytesTotal : p.filesTotal;
      return withFile(
        {
          heading: `Backing up${part}`,
          detail: detailText(p.filesDone, p.filesTotal, p.bytesDone, p.bytesTotal),
          fraction: fractionOf(done, total),
        },
        p.currentFile,
      );
    }
  }
}

export function viewRestoreProgress(p: RestoreProgress): ProgressView {
  switch (p.phase) {
    case "snapshot":
      return { heading: "Taking a safety snapshot first…", detail: "", fraction: null };
    case "writing":
    case "deleting": {
      const done = p.bytesTotal > 0 && p.phase === "writing" ? p.bytesDone : p.filesDone;
      const total = p.bytesTotal > 0 && p.phase === "writing" ? p.bytesTotal : p.filesTotal;
      return withFile(
        {
          heading: p.phase === "writing" ? "Restoring files" : "Removing extra files",
          detail: detailText(p.filesDone, p.filesTotal, p.bytesDone, p.bytesTotal),
          fraction: fractionOf(done, total),
        },
        p.currentFile,
      );
    }
  }
}

/** Text of the cancel button and the note shown after it was pressed. */
export const CANCEL_LABEL = "Cancel";
export const CANCELLING_NOTE = "Cancelling… the current step will finish first.";

/**
 * Cancellation flag shared between a dialog and an engine. The engine polls `isCancelled`
 * (RunOptions / RestoreControl); the dialog's cancel button calls `cancel()`.
 */
export class CancelSource {
  private flag = false;
  private readonly listeners = new Set<() => void>();

  readonly isCancelled = (): boolean => this.flag;

  cancel(): void {
    if (this.flag) return;
    this.flag = true;
    for (const listener of this.listeners) listener();
  }

  /** Called once when cancel() is first requested. Returns an unsubscribe function. */
  onCancel(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Limits redraws: engines report progress for every file, but the screen only needs a few
 * updates a second. `shouldRender` is true at most once per `minIntervalMs`, and always for
 * the first call.
 */
export class RenderThrottle {
  private last: number | null = null;

  constructor(
    private readonly now: () => number,
    private readonly minIntervalMs = 100,
  ) {}

  shouldRender(): boolean {
    const t = this.now();
    if (this.last !== null && t - this.last < this.minIntervalMs) return false;
    this.last = t;
    return true;
  }

  /** Make the next call render (for the final update of a run). */
  reset(): void {
    this.last = null;
  }
}
