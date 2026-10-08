import type { TimerHost, TriggerDeps, TriggerReason } from "./TriggerTypes";

/** How often daily times are checked. Fine enough that a backup is at most this late. */
export const DAILY_CHECK_MS = 20_000;
/** How often the scheduler asks whether a deep verify is due (a cheap read of one small file). */
export const DEEP_CHECK_MS = 10 * 60_000;
const DAILY_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_INTERVAL_MIN = 1;

/** Valid, de-duplicated "HH:MM" strings in order; anything else is dropped. */
export function parseDailyTimes(times: readonly string[]): { hour: number; minute: number }[] {
  const seen = new Set<string>();
  const out: { hour: number; minute: number }[] = [];
  for (const t of times) {
    const m = DAILY_TIME.exec(t.trim());
    if (!m || seen.has(`${m[1]}:${m[2]}`)) continue;
    seen.add(`${m[1]}:${m[2]}`);
    out.push({ hour: Number(m[1]), minute: Number(m[2]) });
  }
  return out;
}

/** Scheduled deep verify, supplied by the host (see core/DeepVerify). */
export interface DeepVerifyJob {
  isDue(): Promise<boolean>;
  run(): Promise<void>;
}

/**
 * Time-based triggers: every N minutes, and at fixed local times of day. Call `start()` once
 * the plugin is ready and `reconfigure()` after settings change; `stop()` on unload.
 *
 * Daily times are checked on a short tick against the wall clock, so they survive a sleeping
 * laptop: a time that passed while asleep fires once on wake (never several times). Nothing
 * fires for times that passed before `start()`: the startup trigger covers that case.
 * The scheduler never starts a run while its own previous run is still going.
 */
export class Scheduler {
  private handles: number[] = [];
  private lastCheck = 0;
  private busy = false;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly host: TimerHost,
    private readonly deepVerify?: DeepVerifyJob,
    private readonly rehearsal?: DeepVerifyJob,
  ) {}

  start(): void {
    this.stop();
    const { triggers } = this.deps.getProfile();
    this.lastCheck = this.deps.clock.now();

    if (triggers.intervalEnabled) {
      const minutes = Math.max(MIN_INTERVAL_MIN, Math.floor(triggers.intervalMinutes) || 0);
      this.handles.push(this.host.setInterval(() => this.fire("interval"), minutes * 60_000));
    }
    const times = parseDailyTimes(triggers.dailyTimes);
    if (times.length < triggers.dailyTimes.length) {
      this.deps.logger.warn("Ignored invalid or duplicate daily backup times");
    }
    if (times.length > 0) {
      this.handles.push(this.host.setInterval(() => this.checkDaily(times), DAILY_CHECK_MS));
    }
    if (this.deepVerify && this.deps.getProfile().verification.scheduledDeepVerify) {
      this.handles.push(this.host.setInterval(() => this.checkJob(this.deepVerify), DEEP_CHECK_MS));
    }
    if (this.rehearsal && this.deps.getProfile().verification.scheduledRehearsal) {
      this.handles.push(this.host.setInterval(() => this.checkJob(this.rehearsal), DEEP_CHECK_MS));
    }
  }

  /** Re-read the settings (call after they change). */
  reconfigure(): void {
    this.start();
  }

  stop(): void {
    for (const h of this.handles) this.host.clearInterval(h);
    this.handles = [];
  }

  get isRunning(): boolean {
    return this.handles.length > 0;
  }

  private checkDaily(times: { hour: number; minute: number }[]): void {
    const now = this.deps.clock.now();
    const since = this.lastCheck;
    this.lastCheck = now;
    if (now <= since) return; // the clock went backwards: wait for it to catch up

    // Today's and yesterday's occurrences cover any gap up to a day; older ones are stale.
    const base = new Date(now);
    for (const { hour, minute } of times) {
      for (const dayOffset of [-1, 0]) {
        const due = new Date(base);
        due.setDate(base.getDate() + dayOffset);
        due.setHours(hour, minute, 0, 0);
        if (due.getTime() > since && due.getTime() <= now) {
          this.fire("daily");
          return; // several missed times still make one backup
        }
      }
    }
  }

  /** Ask a scheduled check whether it is due and run it; one at a time with the backups. */
  private checkJob(job: DeepVerifyJob | undefined): void {
    if (!job || this.busy) return;
    this.busy = true;
    job
      .isDue()
      .then((due) => (due ? job.run() : undefined))
      .catch((error: unknown) => {
        this.deps.logger.error(
          `Scheduled check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private fire(reason: TriggerReason): void {
    if (this.busy) {
      this.deps.logger.debug(`Scheduled backup (${reason}) skipped: previous one still running`);
      return;
    }
    this.busy = true;
    this.deps
      .run(reason)
      .catch((error: unknown) => {
        this.deps.logger.error(
          `Scheduled backup (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
