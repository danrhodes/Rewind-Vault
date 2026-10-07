import type { PreviewItem, RestoreDestination, RestorePreview } from "../core/RestoreTypes";
import { formatBytes } from "../helpers/format";

export type PreviewGroup = "additions" | "changes";

export interface PreviewRow {
  path: string;
  group: PreviewGroup;
  size: number;
  /** Size of the file that would be replaced (changes only). */
  currentSize?: number;
}

const toRow = (item: PreviewItem, group: PreviewGroup): PreviewRow => ({
  path: item.path,
  group,
  size: item.size,
  ...(item.currentSize !== undefined ? { currentSize: item.currentSize } : {}),
});

export interface SelectionOptions {
  /**
   * Whether files that would REPLACE existing ones start ticked. False for a restore into the
   * live vault (replacing needs a deliberate tick), true for the restore folder.
   */
  changesSelected: boolean;
}

/**
 * Which files of a restore preview are ticked. Pure state, no UI. New files and replaced files
 * are listed separately; files that already match are not listed (nothing to restore).
 */
export class RestoreSelection {
  private readonly rowsByGroup: Record<PreviewGroup, PreviewRow[]>;
  private readonly selected = new Set<string>();

  constructor(preview: RestorePreview, options: SelectionOptions) {
    this.rowsByGroup = {
      additions: preview.additions.map((i) => toRow(i, "additions")),
      changes: preview.changes.map((i) => toRow(i, "changes")),
    };
    this.setGroup("additions", true);
    this.setGroup("changes", options.changesSelected);
  }

  rows(group: PreviewGroup): readonly PreviewRow[] {
    return this.rowsByGroup[group];
  }

  get total(): number {
    return this.rowsByGroup.additions.length + this.rowsByGroup.changes.length;
  }

  isSelected(path: string): boolean {
    return this.selected.has(path);
  }

  toggle(path: string): void {
    if (!this.has(path)) return;
    if (!this.selected.delete(path)) this.selected.add(path);
  }

  setGroup(group: PreviewGroup, on: boolean): void {
    for (const row of this.rowsByGroup[group]) {
      if (on) this.selected.add(row.path);
      else this.selected.delete(row.path);
    }
  }

  selectAll(): void {
    this.setGroup("additions", true);
    this.setGroup("changes", true);
  }

  selectNone(): void {
    this.selected.clear();
  }

  /** "none", "some" or "all" of a group is ticked: drives the group checkbox. */
  groupState(group: PreviewGroup): "none" | "some" | "all" {
    const rows = this.rowsByGroup[group];
    const n = rows.filter((r) => this.selected.has(r.path)).length;
    return n === 0 ? "none" : n === rows.length ? "all" : "some";
  }

  get selectedCount(): number {
    return this.selected.size;
  }

  get selectedPaths(): string[] {
    return [...this.selected].sort();
  }

  get selectedBytes(): number {
    return this.all()
      .filter((r) => this.selected.has(r.path))
      .reduce((sum, r) => sum + r.size, 0);
  }

  /** How many ticked files would replace something that is already there. */
  get selectedReplacements(): number {
    return this.rowsByGroup.changes.filter((r) => this.selected.has(r.path)).length;
  }

  get isEverything(): boolean {
    return this.total > 0 && this.selected.size === this.total;
  }

  private has(path: string): boolean {
    return this.all().some((r) => r.path === path);
  }

  private all(): PreviewRow[] {
    return [...this.rowsByGroup.additions, ...this.rowsByGroup.changes];
  }
}

/** What to ask the restore engine for. */
export type RestoreChoice =
  { kind: "vault"; overwrite: boolean } | { kind: "files"; paths: string[]; overwrite: boolean };

/**
 * Turn the ticks into an engine request, or null when nothing is ticked. Ticking a file that
 * replaces an existing one IS the consent to overwrite it; unticked files are never touched.
 */
export function chooseRestore(selection: RestoreSelection): RestoreChoice | null {
  if (selection.selectedCount === 0) return null;
  const overwrite = selection.selectedReplacements > 0;
  return selection.isEverything
    ? { kind: "vault", overwrite }
    : { kind: "files", paths: selection.selectedPaths, overwrite };
}

export interface RestoreSummary {
  /** Lines for the confirmation, in order. */
  lines: string[];
  /** True when the live vault will be changed. */
  touchesVault: boolean;
}

/** Plain-language summary of what pressing Restore will do. */
export function summarizeRestore(
  preview: RestorePreview,
  selection: RestoreSelection,
  destination: RestoreDestination,
  /** The "snapshot before restoring" setting. */
  snapshotEnabled: boolean,
): RestoreSummary {
  const n = selection.selectedCount;
  const files = `${n} file${n === 1 ? "" : "s"} (${formatBytes(selection.selectedBytes)})`;
  const lines: string[] = [];
  if (destination.kind === "restore-folder") {
    lines.push(`Restore ${files} into ${preview.destinationRoot}/. Your notes are not touched.`);
  } else {
    lines.push(`Restore ${files} into your vault.`);
    const r = selection.selectedReplacements;
    if (r > 0) lines.push(`${r} existing file${r === 1 ? " will be" : "s will be"} replaced.`);
    lines.push(
      snapshotEnabled
        ? "A safety snapshot of the current vault is taken first, so this can be undone."
        : "No safety snapshot will be taken (turned off in settings): this cannot be undone.",
    );
  }
  return { lines, touchesVault: destination.kind === "vault" };
}
