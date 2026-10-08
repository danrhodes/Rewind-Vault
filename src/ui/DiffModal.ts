import { Modal, type App } from "obsidian";
import type { RestorePreview } from "../core/RestoreTypes";
import { formatLocalDateTime } from "./backupBrowserModel";
import {
  buildComparison,
  describeFileDiff,
  describeRow,
  summarizeComparison,
  type ComparisonRow,
} from "./diffModel";
import type { Notifier } from "./notify";

export interface DiffHost {
  /** What restoring the whole backup into the vault would change (read only). */
  compare(backupId: string): Promise<RestorePreview>;
  readBackupFile(backupId: string, path: string): Promise<Uint8Array>;
  readLiveFile(path: string): Promise<Uint8Array>;
  notifier: Notifier;
}

/** Rows drawn. The summary still counts every file. */
const MAX_ROWS_SHOWN = 300;

/**
 * Backup versus the vault as it is now: which files changed, were deleted or were added since
 * the backup, and a line diff of any text file you click. "-" lines are in the backup only,
 * "+" lines are in the vault now only. Read only: nothing is restored or changed. All text
 * comes from diffModel.ts (unit tested); this class only draws it.
 */
export class DiffModal extends Modal {
  private diffEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly backupId: string,
    private readonly backupCreatedAt: number,
    private readonly host: DiffHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Compare with ${formatLocalDateTime(this.backupCreatedAt)}`);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Comparing…", cls: "setting-item-description" });
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.diffEl = null;
  }

  private async load(): Promise<void> {
    try {
      const preview = await this.host.compare(this.backupId);
      this.render(buildComparison(preview));
    } catch (error) {
      this.contentEl.empty();
      this.host.notifier.failure("Comparing with the backup", error);
      this.contentEl.createEl("p", { text: "The comparison could not be made." });
    }
  }

  private render(comparison: ReturnType<typeof buildComparison>): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: summarizeComparison(comparison),
      cls: "setting-item-description",
    });
    const list = contentEl.createDiv();
    for (const row of comparison.rows.slice(0, MAX_ROWS_SHOWN)) this.renderRow(list, row);
    if (comparison.rows.length > MAX_ROWS_SHOWN) {
      list.createEl("p", { text: `…and ${comparison.rows.length - MAX_ROWS_SHOWN} more.` });
    }
    this.diffEl = contentEl.createEl("pre");
  }

  private renderRow(parent: HTMLElement, row: ComparisonRow): void {
    const { title, detail } = describeRow(row);
    const el = parent.createDiv({ cls: "rewind-vault-backup-row" });
    const text = el.createDiv();
    text.createEl("strong", { text: title });
    text.createEl("div", { text: detail, cls: "setting-item-description" });
    el.createEl("button", { text: "Show changes" }).addEventListener(
      "click",
      () => void this.showDiff(row),
    );
  }

  private async showDiff(row: ComparisonRow): Promise<void> {
    const target = this.diffEl;
    if (!target) return;
    target.empty();
    try {
      const backup =
        row.kind === "only-vault" ? null : await this.host.readBackupFile(this.backupId, row.path);
      const current = row.kind === "only-backup" ? null : await this.host.readLiveFile(row.path);
      const view = describeFileDiff(row.path, backup, current);
      if (view.kind === "unavailable") {
        target.setText(`${row.path}: ${view.reason}`);
        return;
      }
      target.createEl("div", {
        text: `${row.path}: ${view.removed} line(s) only in the backup (-), ${view.added} only now (+)`,
      });
      for (const line of view.lines) {
        if (line.kind === "gap") {
          target.createEl("div", { text: `… ${line.hidden} unchanged line(s) …` });
          continue;
        }
        const mark = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
        const el = target.createEl("div", { text: mark + line.text });
        if (line.kind === "add") el.setCssProps({ color: "var(--text-success)" });
        if (line.kind === "del") el.setCssProps({ color: "var(--text-error)" });
      }
    } catch (error) {
      this.host.notifier.failure("Reading the file", error);
    }
  }
}
