import { CancelledError } from "../helpers/errors";
import type { RunProgress } from "./RunTypes";

/** Progress reporting and cancellation for one backup run. */
export class RunControl {
  private progress: RunProgress = {
    phase: "scanning",
    partIndex: 0,
    partCount: 0,
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
  };

  constructor(
    private readonly onProgress?: (progress: RunProgress) => void,
    private readonly cancelled?: () => boolean,
  ) {}

  get isCancelled(): boolean {
    return this.cancelled?.() === true;
  }

  assertNotCancelled(): void {
    if (this.isCancelled) throw new CancelledError("Backup cancelled");
  }

  update(patch: Partial<RunProgress>): void {
    this.progress = { ...this.progress, ...patch };
    this.emit();
  }

  fileDone(path: string, size: number): void {
    this.progress = {
      ...this.progress,
      filesDone: this.progress.filesDone + 1,
      bytesDone: this.progress.bytesDone + size,
      currentFile: path,
    };
    this.emit();
  }

  private emit(): void {
    try {
      this.onProgress?.({ ...this.progress });
    } catch {
      // A broken progress listener must never break a backup.
    }
  }
}
