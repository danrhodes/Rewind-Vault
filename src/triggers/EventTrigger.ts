import { createExcludeCheck, scanOptionsFromProfile } from "../core/Scanner";
import { isInsideFolder } from "../helpers/glob";
import type { TimerHost, TriggerDeps, TriggerReason } from "./TriggerTypes";

export type VaultEventKind = "modify" | "create" | "delete" | "rename";

/**
 * Vault change notifications, supplied by the host (main wires `app.vault.on(...)`). `rename`
 * reports the new path. Returns an unsubscribe function.
 */
export interface VaultEvents {
  on(kind: VaultEventKind, callback: (path: string) => void): () => void;
}

/** Quiet time after a burst of create/delete/rename events before they cause one backup. */
export const EVENT_DEBOUNCE_MS = 10_000;
/** Repeated modify events for one file inside this window (autosave) count as one edit. */
export const EDIT_COALESCE_MS = 10_000;

const MINUTE = 60_000;

/**
 * Backups driven by what the user does in the vault:
 *  - after N edits (a file's autosave burst counts once),
 *  - after the vault has been idle for N minutes following changes,
 *  - after files are created, deleted or renamed (debounced: a bulk operation makes one backup).
 * Events inside the backup folder or restore folder, and in excluded paths, are ignored, so
 * backups and restores never trigger themselves. Nothing fires while a triggered run is still
 * going; changes made meanwhile still count toward the next one. Settings are read live.
 */
export class EventTrigger {
  private unsubscribers: (() => void)[] = [];
  private idleTimer: number | null = null;
  private debounceTimer: number | null = null;
  private debounceReason: TriggerReason | null = null;
  private editCount = 0;
  private dirty = false;
  private busy = false;
  private lastEditAt = new Map<string, number>();

  constructor(
    private readonly deps: TriggerDeps,
    private readonly host: TimerHost,
    private readonly events: VaultEvents,
  ) {}

  start(): void {
    this.stop();
    const kinds: VaultEventKind[] = ["modify", "create", "delete", "rename"];
    for (const kind of kinds) {
      this.unsubscribers.push(this.events.on(kind, (path) => this.handle(kind, path)));
    }
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.clearTimers();
    this.editCount = 0;
    this.dirty = false;
    this.lastEditAt.clear();
  }

  get isActive(): boolean {
    return this.unsubscribers.length > 0;
  }

  /** Edits counted toward the next "after N edits" backup (exposed for the status UI and tests). */
  get pendingEdits(): number {
    return this.editCount;
  }

  private ignored(path: string): boolean {
    const profile = this.deps.getProfile();
    if (isInsideFolder(path, profile.destination.restoreFolder)) return true;
    return createExcludeCheck(scanOptionsFromProfile(profile))(path);
  }

  private handle(kind: VaultEventKind, path: string): void {
    if (this.ignored(path)) return;
    const { triggers } = this.deps.getProfile();
    const now = this.deps.clock.now();
    this.dirty = true;

    if (kind === "modify" && triggers.afterEditsEnabled) {
      // The window starts at the last COUNTED edit, so a long typing session on one file still
      // counts roughly once per window rather than once in total.
      const last = this.lastEditAt.get(path);
      if (last === undefined || now - last >= EDIT_COALESCE_MS) {
        this.lastEditAt.set(path, now);
        this.editCount++;
        if (this.editCount >= Math.max(1, triggers.afterEdits)) {
          this.fire("edits");
          return;
        }
      }
    }
    if (kind !== "modify") {
      const wanted =
        (kind === "create" && triggers.onCreate) ||
        (kind === "delete" && triggers.onDelete) ||
        (kind === "rename" && triggers.onRename);
      if (wanted) this.debounce(kind);
    }
    if (triggers.idleEnabled) this.armIdle(triggers.idleMinutes);
  }

  private debounce(reason: TriggerReason): void {
    this.debounceReason ??= reason;
    if (this.debounceTimer !== null) this.host.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.host.setTimeout(() => {
      this.debounceTimer = null;
      const why = this.debounceReason ?? reason;
      this.debounceReason = null;
      this.fire(why);
    }, EVENT_DEBOUNCE_MS);
  }

  private armIdle(minutes: number): void {
    if (this.idleTimer !== null) this.host.clearTimeout(this.idleTimer);
    this.idleTimer = this.host.setTimeout(
      () => {
        this.idleTimer = null;
        if (this.dirty) this.fire("idle");
      },
      Math.max(1, minutes) * MINUTE,
    );
  }

  private clearTimers(): void {
    if (this.idleTimer !== null) this.host.clearTimeout(this.idleTimer);
    if (this.debounceTimer !== null) this.host.clearTimeout(this.debounceTimer);
    this.idleTimer = null;
    this.debounceTimer = null;
    this.debounceReason = null;
  }

  private fire(reason: TriggerReason): void {
    if (this.busy) {
      this.deps.logger.debug(`Event backup (${reason}) skipped: previous one still running`);
      return;
    }
    // One backup covers everything so far, whichever trigger asked for it.
    this.clearTimers();
    this.editCount = 0;
    this.dirty = false;
    this.lastEditAt.clear();
    this.busy = true;
    this.deps
      .run(reason)
      .catch((error: unknown) => {
        this.deps.logger.error(
          `Event backup (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
