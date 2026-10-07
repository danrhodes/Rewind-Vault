import type { RestoreBatchResult } from "../core/RestoreBatch";
import type { RestoreEngine } from "../core/RestoreEngine";
import type { RestoreDestination, RestorePreview } from "../core/RestoreTypes";
import {
  BrokenChainError,
  CancelledError,
  RestoreError,
  WrongPassphraseError,
} from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { Notifier } from "../ui/notify";
import { CancelSource } from "../ui/progressModel";
import type { RestoreChoice } from "../ui/restorePreviewModel";
import { BusyFlag, type ProgressUi } from "./actions";

export interface RestoreActionDeps {
  restore: Pick<RestoreEngine, "preview" | "restoreVault" | "restoreFiles">;
  notifier: Notifier;
  logger: ILogger;
  progress: ProgressUi;
}

/** Restore operations behind the restore dialog. Shares the busy flag with the backup actions. */
export class RestoreActions {
  constructor(
    private readonly deps: RestoreActionDeps,
    private readonly flag: BusyFlag,
  ) {}

  /**
   * What restoring this backup would do. Read-only, so it is allowed while another operation
   * runs. Returns null (after telling the user why) when it cannot be worked out.
   */
  async preview(backupId: string, destination: RestoreDestination): Promise<RestorePreview | null> {
    try {
      return await this.deps.restore.preview({
        source: { id: backupId },
        scope: { kind: "all" },
        destination,
      });
    } catch (error) {
      this.fail("Reading the backup", error);
      return null;
    }
  }

  /** Run the chosen restore with a cancellable progress dialog. True if it completed. */
  async run(
    backupId: string,
    destination: RestoreDestination,
    choice: RestoreChoice,
  ): Promise<boolean> {
    const { notifier, progress, restore } = this.deps;
    if (!this.flag.tryAcquire()) {
      notifier.warning("Another Rewind Vault operation is already running.");
      return false;
    }
    const cancel = new CancelSource();
    const handle = progress.open("Restoring", cancel);
    const control = {
      onProgress: (p: Parameters<typeof handle.updateRestore>[0]) => handle.updateRestore(p),
      isCancelled: cancel.isCancelled,
    };
    try {
      const source = { id: backupId };
      const result: RestoreBatchResult =
        choice.kind === "vault"
          ? await restore.restoreVault(
              { source, destination, overwrite: choice.overwrite },
              control,
            )
          : await restore.restoreFiles(
              { source, paths: choice.paths, destination, overwrite: choice.overwrite },
              control,
            );
      notifier.success(describeResult(result));
      return true;
    } catch (error) {
      this.fail("Restore", error);
      return false;
    } finally {
      handle.close();
      this.flag.release();
    }
  }

  private fail(action: string, error: unknown): void {
    const { notifier, logger } = this.deps;
    if (error instanceof CancelledError) {
      notifier.warning(
        "Restore cancelled. Files already written were kept; nothing else was changed.",
      );
    } else if (error instanceof WrongPassphraseError) {
      notifier.error("Wrong passphrase. Nothing was restored.");
    } else if (error instanceof RestoreError || error instanceof BrokenChainError) {
      notifier.error(`${action} stopped: ${error.message}`);
    } else {
      logger.error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
      notifier.failure(action, error);
    }
  }
}

function describeResult(r: RestoreBatchResult): string {
  const parts = [`${r.created} new`, `${r.replaced} replaced`];
  if (r.unchanged > 0) parts.push(`${r.unchanged} already matched`);
  const where = r.destinationRoot === "" ? "into your vault" : `into ${r.destinationRoot}/`;
  return `Restore complete ${where}: ${parts.join(", ")}.`;
}
