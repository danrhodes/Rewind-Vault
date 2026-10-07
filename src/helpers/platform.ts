import type { PlatformKind } from "../types";

export interface BatteryStatus {
  /** 0-100. */
  level: number;
  charging: boolean;
}

/** Everything platform-specific the plugin needs, behind one mockable interface. */
export interface IPlatform {
  readonly isMobile: boolean;
  readonly isDesktop: boolean;
  readonly kind: PlatformKind;
  /** Null when the Battery API is unavailable (iOS, some desktops). */
  getBattery(): Promise<BatteryStatus | null>;
  isVisible(): boolean;
  /** Subscribe to foreground/background changes. Returns an unsubscribe function. */
  onVisibilityChange(callback: (visible: boolean) => void): () => void;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
}

/** The slice of `Document` used for visibility tracking. */
export interface VisibilityDoc {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PlatformEnv {
  /** From Obsidian's `Platform`, passed in by main.ts so helpers stay free of `obsidian`. */
  isMobile: boolean;
  isDesktop: boolean;
  /** Injected for tests. Defaults to the global `document`. */
  doc?: VisibilityDoc;
  /** Injected for tests. Defaults to `navigator.getBattery` when present. */
  getBatteryManager?: () => Promise<BatteryManagerLike>;
}

function defaultBatteryManager(): (() => Promise<BatteryManagerLike>) | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
  return nav.getBattery ? () => nav.getBattery!() : undefined;
}

export function createPlatform(env: PlatformEnv): IPlatform {
  const doc = env.doc ?? (typeof document === "undefined" ? undefined : document);
  const batteryManager = env.getBatteryManager ?? defaultBatteryManager();

  return {
    isMobile: env.isMobile,
    isDesktop: env.isDesktop,
    kind: env.isMobile ? "mobile" : "desktop",

    async getBattery() {
      if (!batteryManager) return null;
      try {
        const b = await batteryManager();
        return { level: Math.round(b.level * 100), charging: b.charging };
      } catch {
        return null;
      }
    },

    isVisible() {
      return doc ? doc.visibilityState !== "hidden" : true;
    },

    onVisibilityChange(callback) {
      if (!doc) return () => undefined;
      const handler = (): void => callback(doc.visibilityState !== "hidden");
      doc.addEventListener("visibilitychange", handler);
      return () => doc.removeEventListener("visibilitychange", handler);
    },
  };
}
