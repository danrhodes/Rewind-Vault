import type { IPlatform } from "../helpers/platform";
import type { TriggerDeps } from "./TriggerTypes";

/**
 * The host's "the window is about to close" signal. main.ts wires it to the window's
 * `beforeunload` event; it returns an unsubscribe function.
 */
export interface CloseEvents {
  onBeforeClose(callback: () => void): () => void;
}

/**
 * Backup as Obsidian closes (desktop only). This is BEST EFFORT: the app does not wait for
 * asynchronous work in a close handler, so the run may be cut short. That is safe, because
 * backups are written atomically and the manifest last, so an interrupted one leaves no
 * partial backup behind (the next run discards it or resumes it). It fires at most once per
 * `start`, and never on mobile, where the app is suspended rather than closed.
 */
export class CloseTrigger {
  private unsubscribe: (() => void) | null = null;
  private fired = false;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly platform: IPlatform,
    private readonly events: CloseEvents,
  ) {}

  start(): void {
    this.stop();
    this.fired = false;
    if (!this.platform.isDesktop) return;
    this.unsubscribe = this.events.onBeforeClose(() => this.onClose());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get isActive(): boolean {
    return this.unsubscribe !== null;
  }

  private onClose(): void {
    if (this.fired || !this.deps.getProfile().triggers.onClose) return;
    this.fired = true;
    this.deps.run("close").catch((error: unknown) => {
      this.deps.logger.error(
        `Backup on close failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
