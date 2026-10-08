import type { ILogger } from "../helpers/logger";
import { isValidExternalPath, type ExternalCopy } from "../storage/ExternalCopy";
import type { IPlatform } from "../helpers/platform";
import type { SettingsProfile } from "../types";
import type { BackupEngine, ResumeInfo } from "./BackupEngine";
import { loadIndex } from "./BackupIndex";
import type { RunOptions, RunResult } from "./RunTypes";

export interface MirrorDeps {
  engine: BackupEngine;
  /** Null where Node is not available (mobile). */
  copier: ExternalCopy | null;
  platform: IPlatform;
  logger: ILogger;
  getProfile: () => SettingsProfile;
  store: Parameters<typeof loadIndex>[0];
}

/**
 * The backup engine plus the optional external copy (desktop, destination "external"): after a
 * backup completes, its folder is mirrored outside the vault. The backup itself is always made
 * in the vault first. A failed copy never fails the backup: it is reported in the result
 * (`externalCopy`), and the backup stays valid in the vault. Same interface as the engine
 * where callers need it.
 */
export class BackupMirror implements Pick<BackupEngine, "run" | "resume" | "findResumable"> {
  constructor(private readonly deps: MirrorDeps) {}

  async run(options: RunOptions): Promise<RunResult> {
    return this.mirror(await this.deps.engine.run(options));
  }

  async resume(options: RunOptions): Promise<RunResult> {
    return this.mirror(await this.deps.engine.resume(options));
  }

  findResumable(): Promise<ResumeInfo | null> {
    return this.deps.engine.findResumable();
  }

  private async mirror(result: RunResult): Promise<RunResult> {
    const { logger, platform, copier, store } = this.deps;
    const { destination } = this.deps.getProfile();
    if (result.status !== "completed" || destination.destination !== "external") return result;
    if (!platform.isDesktop || !copier) {
      return { ...result, externalCopy: failed("External copy is only available on desktop.") };
    }
    if (!isValidExternalPath(destination.externalPath)) {
      return {
        ...result,
        externalCopy: failed("The external copy path is empty or not an absolute folder path."),
      };
    }
    try {
      const index = await loadIndex(store, destination.backupFolder);
      const entry = index.backups.find((b) => b.id === result.backupId);
      if (!entry) throw new Error(`backup ${result.backupId} is not in the index`);
      const copied = await copier.copyBackup(
        destination.backupFolder,
        entry.folder,
        destination.externalPath,
      );
      return {
        ...result,
        externalCopy: {
          ok: true,
          message: `Copied ${copied.files} file(s) to ${copied.destination}.`,
        },
      };
    } catch (error) {
      const message = describeError(error);
      logger.error(`External copy failed: ${message}`);
      return { ...result, externalCopy: failed(message) };
    }
  }
}

const failed = (message: string) => ({ ok: false as const, message });

/** The error's message plus the message of what caused it, which carries the real reason. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}
