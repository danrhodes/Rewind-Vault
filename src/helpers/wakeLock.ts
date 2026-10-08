/** Releases a screen wake lock. Safe to call more than once. */
export type ReleaseWakeLock = () => Promise<void>;

interface SentinelLike {
  release(): Promise<void>;
}

/** The slice of `navigator.wakeLock` used here, so tests need no browser. */
export interface WakeLockApi {
  request(type: "screen"): Promise<SentinelLike>;
}

/** The browser's Screen Wake Lock API, or null where it is missing (older iOS, desktop shells). */
export function defaultWakeLockApi(): WakeLockApi | null {
  if (typeof navigator === "undefined") return null;
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  return api ?? null;
}

/**
 * Ask the system to keep the screen on, so a phone does not suspend the app mid-backup.
 * Never throws: with no support, or when the system refuses (low battery saver, hidden
 * page), it resolves null and the backup simply runs without it.
 */
export async function acquireWakeLock(
  api: WakeLockApi | null = defaultWakeLockApi(),
): Promise<ReleaseWakeLock | null> {
  if (!api) return null;
  try {
    const sentinel = await api.request("screen");
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await sentinel.release();
      } catch {
        // Already released by the system when the page was hidden.
      }
    };
  } catch {
    return null;
  }
}
