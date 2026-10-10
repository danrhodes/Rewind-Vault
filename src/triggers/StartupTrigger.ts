import type { TimerHost, TriggerDeps } from "./TriggerTypes";

const MAX_DELAY_SEC = 300;
const HOUR_MS = 3_600_000;

/** Whether a backup on startup is wanted: BOTH the Basic switch and the Triggers switch are on. */
export function startupEnabled(deps: Pick<TriggerDeps, "getProfile">): boolean {
  const profile = deps.getProfile();
  return profile.basic.backupOnStartup && profile.triggers.onStartup;
}

/**
 * Backup shortly after Obsidian has finished loading. `start` takes Obsidian's
 * `app.workspace.onLayoutReady` (or any "call me when ready" function), so startup work never
 * competes with the app's own loading; then it waits `startupDelaySec` (0 to 300) and asks for
 * one backup. Settings are read when the delay ends, so turning the option off during the
 * delay cancels it. Fires at most once per `start`; `stop` (plugin unload) cancels a pending one.
 */
export class StartupTrigger {
  private timer: number | null = null;
  private generation = 0;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly host: TimerHost,
    private readonly options: { lastBackupAt?: () => Promise<number | null> } = {},
  ) {}

  start(whenReady: (callback: () => void) => void): void {
    this.stop();
    const generation = this.generation;
    whenReady(() => {
      if (generation !== this.generation) return; // stopped before the app was ready
      if (!startupEnabled(this.deps)) return;
      const delaySec = Math.min(
        MAX_DELAY_SEC,
        Math.max(0, Math.floor(this.deps.getProfile().basic.startupDelaySec) || 0),
      );
      if (delaySec === 0) {
        this.fire();
        return;
      }
      this.timer = this.host.setTimeout(() => {
        this.timer = null;
        this.fire();
      }, delaySec * 1000);
    });
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) this.host.clearTimeout(this.timer);
    this.timer = null;
  }

  get isPending(): boolean {
    return this.timer !== null;
  }

  /** The minimum gap in ms, or 0 when the check is off. */
  private gapMs(): number {
    if (!this.options.lastBackupAt) return 0;
    return Math.max(0, this.deps.getProfile().basic.startupMinGapHours) * HOUR_MS;
  }

  /** True if a backup newer than the minimum gap exists. A failed lookup counts as no. */
  private async backedUpRecently(gapMs: number): Promise<boolean> {
    try {
      const last = (await this.options.lastBackupAt?.()) ?? null;
      return last !== null && this.deps.clock.now() - last < gapMs;
    } catch {
      return false;
    }
  }

  private fire(): void {
    if (!startupEnabled(this.deps)) return;
    const gapMs = this.gapMs();
    if (gapMs === 0) {
      this.run();
      return;
    }
    void this.backedUpRecently(gapMs).then((recent) => {
      if (recent) {
        this.deps.logger.info("Backup on startup skipped: a recent backup exists");
        return;
      }
      this.run();
    });
  }

  private run(): void {
    if (!startupEnabled(this.deps)) return;
    this.deps.logger.info("Backup on startup");
    this.deps.run("startup").catch((error: unknown) => {
      this.deps.logger.error(
        `Startup backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
