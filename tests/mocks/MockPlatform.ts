import type { BatteryStatus, IPlatform } from "../../src/helpers/platform";
import type { PlatformKind } from "../../src/types";

/** Controllable IPlatform for trigger and condition tests. */
export class MockPlatform implements IPlatform {
  readonly isMobile: boolean;
  readonly isDesktop: boolean;
  readonly kind: PlatformKind;
  battery: BatteryStatus | null = null;
  visible = true;
  private listeners = new Set<(visible: boolean) => void>();

  constructor(kind: PlatformKind = "desktop") {
    this.kind = kind;
    this.isMobile = kind === "mobile";
    this.isDesktop = kind === "desktop";
  }

  async getBattery(): Promise<BatteryStatus | null> {
    return this.battery;
  }

  isVisible(): boolean {
    return this.visible;
  }

  onVisibilityChange(callback: (visible: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const l of this.listeners) l(visible);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
