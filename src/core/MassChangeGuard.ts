import type { IClock } from "../helpers/time";

export interface MassChangeLimits {
  enabled: boolean;
  /** Pause when MORE than this many different files change inside the window. */
  threshold: number;
  windowSec: number;
}

export interface MassChangeTrip {
  /** Different files that changed inside the window when the guard tripped. */
  files: number;
  windowSec: number;
  trippedAt: number;
}

/**
 * Protects the last good backup from a mass change: ransomware, a bad sync or a misbehaving
 * plugin that rewrites or deletes hundreds of notes at once. When more than `threshold`
 * different files change within `windowSec`, the guard trips and stays tripped until the user
 * releases it, and automatic backups must not run meanwhile (a backup of the damaged vault
 * could push the good ones out through retention). Each file counts once per window, so one
 * autosaving note never trips it. Limits are read live; turning the guard off clears it.
 */
export class MassChangeGuard {
  private readonly lastSeen = new Map<string, number>();
  private trip: MassChangeTrip | null = null;

  constructor(
    private readonly clock: IClock,
    private readonly limits: () => MassChangeLimits,
  ) {}

  get isTripped(): boolean {
    return this.trip !== null && this.limits().enabled;
  }

  get tripInfo(): MassChangeTrip | null {
    return this.isTripped ? this.trip : null;
  }

  /**
   * Note that a file changed (created, edited, deleted or renamed). Returns true only for the
   * call that trips the guard, so the caller can raise the alert exactly once.
   */
  record(path: string): boolean {
    const limits = this.limits();
    if (!limits.enabled) {
      this.lastSeen.clear();
      this.trip = null;
      return false;
    }
    if (this.trip) return false;
    const now = this.clock.now();
    const cutoff = now - Math.max(1, limits.windowSec) * 1000;
    this.lastSeen.set(path, now);
    for (const [seenPath, at] of this.lastSeen) {
      if (at <= cutoff) this.lastSeen.delete(seenPath);
    }
    if (this.lastSeen.size <= Math.max(1, limits.threshold)) return false;
    this.trip = { files: this.lastSeen.size, windowSec: limits.windowSec, trippedAt: now };
    this.lastSeen.clear();
    return true;
  }

  /** The user says the changes were intended: backups may run again. */
  release(): void {
    this.trip = null;
    this.lastSeen.clear();
  }
}
