import { createExcludeCheck, scanOptionsFromProfile } from "../core/Scanner";
import { isInsideFolder } from "../helpers/glob";
import type { VaultEvents } from "./EventTrigger";
import type { TimerHost, TriggerDeps } from "./TriggerTypes";

/** Edits to a note are read at most this often; a burst of autosaves is read once. */
export const READ_GAP_MS = 5_000;
/** Notes bigger than this are not read for word counts (reading them on every edit would be slow). */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** Words in a text: runs of non-space characters. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Reads a note's text, or null if it is missing, unreadable or too big. */
export type NoteReader = (path: string) => Promise<string | null>;

/**
 * Backup after N words have been added or removed (settings triggers.afterWordsEnabled and
 * afterWords). Edits are noticed from vault events; the changed note is read at most once per
 * READ_GAP_MS and its word count compared with the count the last time it was read. The first
 * time a note is seen it only sets that baseline (nothing is counted), so a session starts at
 * zero. The running total resets whenever it fires. Only notes (.md) count; the backup and
 * restore folders and excluded paths are ignored. Settings are read live.
 */
export class EditVolumeTrigger {
  private unsubscribers: (() => void)[] = [];
  private timer: number | null = null;
  private readonly pending = new Set<string>();
  private readonly baseline = new Map<string, number>();
  private total = 0;
  private busy = false;
  private generation = 0;

  constructor(
    private readonly deps: TriggerDeps,
    private readonly host: TimerHost,
    private readonly events: VaultEvents,
    private readonly read: NoteReader,
  ) {}

  start(): void {
    this.stop();
    this.unsubscribers.push(
      this.events.on("modify", (path) => this.onModify(path)),
      this.events.on("delete", (path) => this.baseline.delete(path)),
    );
  }

  stop(): void {
    this.generation++;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.timer !== null) this.host.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.baseline.clear();
    this.total = 0;
  }

  get isActive(): boolean {
    return this.unsubscribers.length > 0;
  }

  /** Words counted toward the next backup (for tests and a future status display). */
  get pendingWords(): number {
    return this.total;
  }

  private ignored(path: string): boolean {
    if (!path.toLowerCase().endsWith(".md")) return true;
    const profile = this.deps.getProfile();
    if (isInsideFolder(path, profile.destination.restoreFolder)) return true;
    return createExcludeCheck(scanOptionsFromProfile(profile))(path);
  }

  private onModify(path: string): void {
    if (!this.deps.getProfile().triggers.afterWordsEnabled || this.ignored(path)) return;
    this.pending.add(path);
    this.timer ??= this.host.setTimeout(() => void this.flush(), READ_GAP_MS);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const generation = this.generation;
    const paths = [...this.pending];
    this.pending.clear();
    for (const path of paths) {
      let text: string | null = null;
      try {
        text = await this.read(path);
      } catch {
        text = null;
      }
      if (generation !== this.generation) return; // stopped while reading
      if (text === null) {
        this.baseline.delete(path);
        continue;
      }
      const words = countWords(text);
      const before = this.baseline.get(path);
      this.baseline.set(path, words);
      if (before !== undefined) this.total += Math.abs(words - before);
    }
    const { triggers } = this.deps.getProfile();
    if (!triggers.afterWordsEnabled || this.total < Math.max(1, triggers.afterWords)) return;
    this.fire();
  }

  private fire(): void {
    if (this.busy) {
      this.deps.logger.debug("Word-count backup skipped: previous one still running");
      return;
    }
    this.total = 0;
    this.busy = true;
    this.deps
      .run("words")
      .catch((error: unknown) => {
        this.deps.logger.error(
          `Word-count backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
