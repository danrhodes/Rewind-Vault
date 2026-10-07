import type { RunProgress } from "../core/RunTypes";
import type { IClock } from "../helpers/time";
import type { IPlatform } from "../helpers/platform";
import type { SettingsProfile } from "../types";

/** The slice of an Obsidian status bar element we use. main.ts wraps `addStatusBarItem()`. */
export interface StatusBarItem {
  setText(text: string): void;
  remove(): void;
}

export interface StatusBarDeps {
  platform: IPlatform;
  clock: IClock;
  getProfile: () => SettingsProfile;
  createItem: () => StatusBarItem;
}

type State =
  | { kind: "idle"; lastBackupAt: number | null }
  | { kind: "running"; progress: RunProgress }
  | { kind: "error" };

const PREFIX = "Rewind Vault";

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Backup state in Obsidian's status bar. Desktop only: on mobile there is no status bar, so no
 * item is ever created. The `notifications.statusBar` setting is re-read on every `refresh()`
 * (and on every update), so toggling it adds or removes the item without a restart.
 */
export class StatusBar {
  private item: StatusBarItem | null = null;
  private state: State = { kind: "idle", lastBackupAt: null };
  private lastText: string | null = null;

  constructor(private readonly deps: StatusBarDeps) {}

  get isVisible(): boolean {
    return this.item !== null;
  }

  setIdle(lastBackupAt: number | null): void {
    this.state = { kind: "idle", lastBackupAt };
    this.refresh();
  }

  setProgress(progress: RunProgress): void {
    this.state = { kind: "running", progress };
    this.refresh();
  }

  setError(): void {
    this.state = { kind: "error" };
    this.refresh();
  }

  /** Re-apply the setting and redraw (call now and then so "5 min ago" stays current). */
  refresh(): void {
    const wanted = this.deps.platform.isDesktop && this.deps.getProfile().notifications.statusBar;
    if (!wanted) {
      this.dispose();
      return;
    }
    this.item ??= this.deps.createItem();
    const text = this.render();
    if (text !== this.lastText) {
      this.item.setText(text);
      this.lastText = text;
    }
  }

  /** Remove the item (plugin unload, or the setting was turned off). */
  dispose(): void {
    this.item?.remove();
    this.item = null;
    this.lastText = null;
  }

  private render(): string {
    const s = this.state;
    switch (s.kind) {
      case "error":
        return `${PREFIX}: last backup failed`;
      case "running":
        return `${PREFIX}: ${progressText(s.progress)}`;
      case "idle":
        return s.lastBackupAt === null
          ? `${PREFIX}: no backup yet`
          : `${PREFIX}: backed up ${formatAgo(this.deps.clock.now() - s.lastBackupAt)}`;
    }
  }
}

function progressText(p: RunProgress): string {
  switch (p.phase) {
    case "scanning":
      return "scanning…";
    case "finalizing":
      return "finishing…";
    case "verifying":
      return "verifying…";
    case "packing": {
      const pct =
        p.bytesTotal > 0 ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100)) : 0;
      return `backing up ${pct}%`;
    }
  }
}
