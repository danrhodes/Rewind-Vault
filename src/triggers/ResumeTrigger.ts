import type { IPlatform } from "../helpers/platform";
import type { TriggerDeps } from "./TriggerTypes";

const MIN_MS = 60_000;

export interface ResumeOptions {
  /**
   * When the newest backup was made (ms), or null if none. Lets the gap count backups made by
   * other triggers, not just resume-triggered ones. Optional; errors are treated as unknown.
   */
  lastBackupAt?: () => Promise<number | null>;
}

/**
 * Backup when the app comes back to the foreground (a phone unlocked, a window shown again),
 * at most once per `resumeMinGapMin`. The gap is measured from the later of the last backup
 * (if the host can say) and the last time this trigger fired, so flicking between apps never
 * causes a backup storm. The first visibility event only ever counts as a resume if the app
 * was hidden before it: starting up visible is the startup trigger's business.
 */
export class ResumeTrigger {
  private unsubscribe: (() => void) | null = null;
  private lastFiredAt: number | null = null;
  private wasHidden = false;
  private busy = false;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly platform: IPlatform,
    private readonly options: ResumeOptions = {},
  ) {}

  start(): void {
    this.stop();
    this.wasHidden = !this.platform.isVisible();
    this.unsubscribe = this.platform.onVisibilityChange((visible) => {
      if (!visible) {
        this.wasHidden = true;
        return;
      }
      if (!this.wasHidden) return;
      this.wasHidden = false;
      void this.onResume();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get isActive(): boolean {
    return this.unsubscribe !== null;
  }

  private async onResume(): Promise<void> {
    const { triggers } = this.deps.getProfile();
    if (!triggers.onResume || this.busy) return;

    const now = this.deps.clock.now();
    const minGapMs = Math.max(0, triggers.resumeMinGapMin) * MIN_MS;
    let lastBackup: number | null = null;
    try {
      lastBackup = (await this.options.lastBackupAt?.()) ?? null;
    } catch {
      lastBackup = null; // unknown: rely on our own record
    }
    const last = Math.max(lastBackup ?? -Infinity, this.lastFiredAt ?? -Infinity);
    if (now - last < minGapMs) {
      this.deps.logger.debug("Resume backup skipped: within the minimum gap");
      return;
    }

    this.lastFiredAt = now;
    this.busy = true;
    try {
      await this.deps.run("resume");
    } catch (error) {
      this.deps.logger.error(
        `Resume backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }
}
