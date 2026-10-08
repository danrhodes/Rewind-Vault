import { BulkChangeDetector } from "../core/BulkChangeDetector";
import type { PluginChange } from "../core/PluginWatch";
import { PRE_RISK } from "../constants";
import { isInsideFolder } from "../helpers/glob";
import type { VaultEvents } from "./EventTrigger";
import type { TimerHost, TriggerDeps } from "./TriggerTypes";

export interface PluginChecker {
  check(): Promise<PluginChange[]>;
}

/**
 * Snapshots before risky moments (setting "pre-risk snapshots"):
 *  - a bulk delete or rename: PRE_RISK.bulkCount different files deleted or renamed within
 *    PRE_RISK.bulkWindowSec seconds, so recent edits are safe before more is lost;
 *  - another plugin installed or updated: checked when the app is ready and every
 *    PRE_RISK.pluginCheckMin minutes (Obsidian sends no event for changes inside the config
 *    folder, so the plugin folder is read instead).
 * The snapshot is a normal automatic run (reason "pre-risk"), so the run guard, conditions and
 * the mass-change guard still apply. The setting is read live.
 */
export class PreRiskTrigger {
  private unsubscribers: (() => void)[] = [];
  private timer: number | null = null;
  private generation = 0;
  private readonly detector: BulkChangeDetector;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly host: TimerHost,
    private readonly events: VaultEvents,
    private readonly plugins: PluginChecker | null,
  ) {
    this.detector = new BulkChangeDetector(deps.clock, {
      count: PRE_RISK.bulkCount,
      windowSec: PRE_RISK.bulkWindowSec,
      cooldownSec: PRE_RISK.cooldownMin * 60,
    });
  }

  start(whenReady: (callback: () => void) => void): void {
    this.stop();
    const generation = this.generation;
    for (const kind of ["delete", "rename"] as const) {
      this.unsubscribers.push(this.events.on(kind, (path) => this.onBulkCandidate(path)));
    }
    if (!this.plugins) return;
    whenReady(() => {
      if (generation !== this.generation) return;
      void this.checkPlugins();
      this.timer = this.host.setInterval(
        () => void this.checkPlugins(),
        PRE_RISK.pluginCheckMin * 60_000,
      );
    });
  }

  stop(): void {
    this.generation++;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.timer !== null) this.host.clearInterval(this.timer);
    this.timer = null;
  }

  get isActive(): boolean {
    return this.unsubscribers.length > 0;
  }

  private enabled(): boolean {
    return this.deps.getProfile().safety.preRiskSnapshots;
  }

  private onBulkCandidate(path: string): void {
    if (!this.enabled()) return;
    // Pruning old backups deletes files too: the backup and restore folders never count.
    const { destination } = this.deps.getProfile();
    if (
      isInsideFolder(path, destination.backupFolder) ||
      isInsideFolder(path, destination.restoreFolder)
    ) {
      return;
    }
    if (!this.detector.record(path)) return;
    this.deps.logger.info("Bulk delete or rename detected: taking a snapshot first");
    this.request();
  }

  /** Look for plugin changes now. Exposed for tests; the timer calls it too. */
  async checkPlugins(): Promise<void> {
    if (!this.plugins) return;
    try {
      // Always read, so the record stays current even while the setting is off.
      const changes = await this.plugins.check();
      if (changes.length === 0 || !this.enabled()) return;
      this.deps.logger.info("A plugin was installed or updated: taking a snapshot");
      this.request();
    } catch (error) {
      this.deps.logger.warn(
        `Plugin check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private request(): void {
    this.deps.run("pre-risk").catch((error: unknown) => {
      this.deps.logger.error(
        `Pre-risk snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
