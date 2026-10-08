import type { IPlatform } from "../helpers/platform";
import type { TimerHost, TriggerDeps } from "./TriggerTypes";

/** How often the battery level is read while the app is running. */
export const BATTERY_POLL_MS = 2 * 60_000;
/** After a flush, the level must climb this far above the threshold (or charging begin) to re-arm. */
export const REARM_MARGIN_PCT = 5;

/**
 * One last backup before the battery dies (settings conditions.lowBatteryFlush and
 * lowBatteryFlushPct). When the level is at or below the threshold and the device is not
 * charging, it asks for a backup with reason "low-battery", which skips the minimum-battery
 * condition (that condition would otherwise block it) but still skips when nothing changed.
 * It fires once per discharge: charging, or the level rising REARM_MARGIN_PCT above the
 * threshold, re-arms it. The level is read on a timer and whenever the app goes to the
 * background, the usual moment a phone is put away. Where the platform gives no battery
 * information (iPhone) it does nothing.
 */
export class LowBatteryTrigger {
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private armed = true;
  private checking = false;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly host: TimerHost,
    private readonly platform: IPlatform,
  ) {}

  start(): void {
    this.stop();
    this.armed = true;
    this.timer = this.host.setInterval(() => void this.check(), BATTERY_POLL_MS);
    this.unsubscribe = this.platform.onVisibilityChange((visible) => {
      if (!visible) void this.check();
    });
  }

  stop(): void {
    if (this.timer !== null) this.host.clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get isActive(): boolean {
    return this.timer !== null;
  }

  /** Read the battery now and flush if needed. Exposed for tests; the timer calls it. */
  async check(): Promise<void> {
    const { conditions } = this.deps.getProfile();
    if (!conditions.lowBatteryFlush || this.checking) return;
    this.checking = true;
    try {
      const battery = await this.platform.getBattery();
      if (!battery) return;
      const limit = conditions.lowBatteryFlushPct;
      if (battery.charging || battery.level > limit + REARM_MARGIN_PCT) {
        this.armed = true;
        return;
      }
      if (!this.armed || battery.level > limit) return;
      this.armed = false;
      this.deps.logger.info(`Battery at ${battery.level}%: saving unsaved changes`);
      await this.deps.run("low-battery");
    } catch (error) {
      this.deps.logger.error(
        `Low-battery backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.checking = false;
    }
  }
}
