/** Tells whether the device is on an unmetered (Wi-Fi or wired) connection. */
export interface INetworkProbe {
  /** True for Wi-Fi/ethernet, false for cellular, null when the platform cannot tell. */
  isUnmetered(): boolean | null;
}

interface ConnectionLike {
  type?: string;
  saveData?: boolean;
}

/**
 * Probe backed by the Network Information API (`navigator.connection`). It exists in Chromium
 * based runtimes (Obsidian desktop and Android) but not on iOS, where the answer is null and
 * callers must not block on it.
 */
export function createNetworkProbe(nav?: { connection?: ConnectionLike }): INetworkProbe {
  const source =
    nav ??
    (typeof navigator === "undefined" ? undefined : (navigator as { connection?: ConnectionLike }));
  return {
    isUnmetered() {
      const type = source?.connection?.type;
      if (type === "wifi" || type === "ethernet") return true;
      if (type === "cellular" || type === "bluetooth") return false;
      return null; // "unknown", "none", "other" or no API
    },
  };
}
