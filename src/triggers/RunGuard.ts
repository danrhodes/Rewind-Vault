import { LockError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import type { RunRequest, TriggerReason } from "./TriggerTypes";

/** Quiet period after a triggered run ends, so two triggers firing together make one backup. */
export const DEFAULT_COOLDOWN_MS = 30_000;

export interface RunGuardDeps {
  clock: IClock;
  logger: ILogger;
  /** The real work: conditions, then the engine. Wired in main/services. */
  run: RunRequest;
  cooldownMs?: number;
  /** Reasons that skip the cooldown (never the overlap check). Default: only "close". */
  bypassCooldown?: readonly TriggerReason[];
}

/**
 * De-duplicates automatic backups. Every trigger shares one guarded `request`:
 * - a request while a run is in progress is dropped (no overlapping runs);
 * - a request within the cooldown after the last run ended is dropped, so startup + resume +
 *   an edit burst arriving together produce one backup, and a failing run is not retried
 *   in a tight loop;
 * - a LockError (another window or device holds the backup lock) is an expected outcome and is
 *   logged quietly, not raised as a failure. Anything else is rethrown for the trigger to log.
 * Manual "Backup now" does not go through the guard, so it is never delayed by the cooldown;
 * the engine's lock still stops it from overlapping a running automatic backup.
 */
export class RunGuard {
  private running = false;
  private lastEndedAt: number | null = null;
  private readonly cooldownMs: number;
  private readonly bypass: ReadonlySet<TriggerReason>;

  constructor(private readonly deps: RunGuardDeps) {
    this.cooldownMs = Math.max(0, deps.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.bypass = new Set(deps.bypassCooldown ?? ["close"]);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Pass this to every trigger as its RunRequest. */
  readonly request: RunRequest = async (reason) => {
    const { logger, clock } = this.deps;
    if (this.running) {
      logger.debug(`Backup requested by "${reason}" dropped: a backup is already running`);
      return;
    }
    if (
      this.lastEndedAt !== null &&
      !this.bypass.has(reason) &&
      clock.now() - this.lastEndedAt < this.cooldownMs
    ) {
      logger.debug(`Backup requested by "${reason}" dropped: within the cooldown`);
      return;
    }
    this.running = true;
    try {
      await this.deps.run(reason);
    } catch (error) {
      if (error instanceof LockError) {
        logger.info(`Backup requested by "${reason}" not started: ${error.message}`);
        return;
      }
      throw error;
    } finally {
      this.running = false;
      this.lastEndedAt = clock.now();
    }
  };
}
