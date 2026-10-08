import type { IClock } from "../helpers/time";

export interface BulkLimits {
  /** Different files deleted or renamed within the window that count as a bulk operation. */
  count: number;
  windowSec: number;
  /** After it fires, stay quiet this long so one bulk operation gives one snapshot. */
  cooldownSec: number;
}

/**
 * Spots a bulk delete or rename (many different files deleted or renamed in a short time) so
 * a snapshot can be taken before more is lost. `record` returns true once per operation.
 */
export class BulkChangeDetector {
  private readonly seen = new Map<string, number>();
  private quietUntil = 0;

  constructor(
    private readonly clock: IClock,
    private readonly limits: BulkLimits,
  ) {}

  record(path: string): boolean {
    const now = this.clock.now();
    if (now < this.quietUntil) return false;
    this.seen.set(path, now);
    const cutoff = now - this.limits.windowSec * 1000;
    for (const [seenPath, at] of this.seen) {
      if (at <= cutoff) this.seen.delete(seenPath);
    }
    if (this.seen.size < this.limits.count) return false;
    this.seen.clear();
    this.quietUntil = now + this.limits.cooldownSec * 1000;
    return true;
  }
}
