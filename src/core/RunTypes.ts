import type { BackupType, VerifyReport } from "../types";

export type RunPhase = "scanning" | "packing" | "finalizing" | "verifying";

/** Snapshot sent to `onProgress`. Totals are known once scanning has finished. */
export interface RunProgress {
  phase: RunPhase;
  /** 1-based number of the part being packed, 0 before packing starts. */
  partIndex: number;
  partCount: number;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentFile?: string;
}

export interface RunOptions {
  mode: BackupType;
  /**
   * Only add backups: existing backup folders are write-protected for this run and
   * retention must not run afterwards.
   */
  nonDestructive?: boolean;
  /** Called often; keep it cheap (the UI should throttle its own redraws). Errors are ignored. */
  onProgress?: (progress: RunProgress) => void;
  /** Polled between files and parts. When true the run stops with CancelledError. */
  isCancelled?: () => boolean;
}

export interface CompletedResult {
  status: "completed";
  backupId: string;
  type: BackupType;
  fileCount: number;
  bytes: number;
  /** Files left out: over-max (when not processed) or vanished during the run. */
  skippedFiles: string[];
  /** Set when a differential was requested but a full backup was made instead. */
  forcedFullReason?: string;
  nonDestructive: boolean;
  /** Result of the automatic check run after the backup; absent when verification is off. */
  verification?: VerifyReport;
}

export interface SkippedResult {
  status: "skipped";
  reason: "no-changes";
}

/** Cancellation is not a result: `run()` throws CancelledError and cleans up. */
export type RunResult = CompletedResult | SkippedResult;
