import { Modal, type App } from "obsidian";
import type { RestoreActions } from "../commands/restoreActions";
import type { RestoreDestination, RestorePreview } from "../core/RestoreTypes";
import { formatBytes } from "../helpers/format";
import { formatLocalDateTime } from "./backupBrowserModel";
import {
  RestoreSelection,
  chooseRestore,
  summarizeRestore,
  type PreviewGroup,
} from "./restorePreviewModel";

export interface RestoreDialogHost {
  actions: RestoreActions;
  /** The "snapshot before restoring" setting, read when the dialog draws its summary. */
  snapshotEnabled(): boolean;
  confirm(
    title: string,
    message: string,
    confirmLabel: string,
    dangerous: boolean,
  ): Promise<boolean>;
}

/** Rows drawn per group. The group checkbox still covers every file; this only keeps the DOM small. */
const MAX_ROWS_SHOWN = 300;

const GROUP_TITLES: Record<PreviewGroup, string> = {
  additions: "New files (not in your vault now)",
  changes: "Files that differ (would replace what is there)",
};

/**
 * Shows what restoring a backup would do and lets the user tick the files to restore. Default
 * destination is the restore folder, which never touches the live vault; restoring into the
 * vault leaves "files that differ" unticked until the user ticks them. The selection logic and
 * all text come from restorePreviewModel.ts (unit tested); this class only draws it.
 */
export class RestorePreviewModal extends Modal {
  private destination: RestoreDestination = { kind: "restore-folder" };
  private preview: RestorePreview | null = null;
  private selection: RestoreSelection | null = null;
  private bodyEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly backupId: string,
    private readonly backupCreatedAt: number,
    private readonly host: RestoreDialogHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Restore from ${formatLocalDateTime(this.backupCreatedAt)}`);
    const { contentEl } = this;
    contentEl.empty();

    const where = contentEl.createDiv();
    where.createEl("label", { text: "Restore to: " });
    const select = where.createEl("select");
    select.createEl("option", { text: "The restore folder (safe)", value: "restore-folder" });
    select.createEl("option", { text: "My vault (replaces files)", value: "vault" });
    select.addEventListener("change", () => {
      this.destination = { kind: select.value === "vault" ? "vault" : "restore-folder" };
      void this.load();
    });

    this.bodyEl = contentEl.createDiv();
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.bodyEl = null;
  }

  private async load(): Promise<void> {
    this.bodyEl?.empty();
    this.bodyEl?.createEl("p", { text: "Reading the backup…" });
    const preview = await this.host.actions.preview(this.backupId, this.destination);
    if (!preview) {
      this.close(); // the reason was already shown as a notice
      return;
    }
    this.preview = preview;
    this.selection = new RestoreSelection(preview, {
      changesSelected: this.destination.kind === "restore-folder",
    });
    this.render();
  }

  private render(): void {
    const { bodyEl, preview, selection } = this;
    if (!bodyEl || !preview || !selection) return;
    bodyEl.empty();

    if (selection.total === 0) {
      bodyEl.createEl("p", {
        text: `Nothing to restore: all ${preview.unchanged} file(s) in this backup already match.`,
      });
      return;
    }
    for (const group of ["additions", "changes"] as const)
      this.renderGroup(bodyEl, selection, group);

    const summary = summarizeRestore(
      preview,
      selection,
      this.destination,
      this.host.snapshotEnabled(),
    );
    const box = bodyEl.createDiv({ cls: "rewind-vault-restore-summary" });
    if (selection.selectedCount === 0) box.createEl("p", { text: "Tick at least one file." });
    else for (const line of summary.lines) box.createEl("p", { text: line });
    if (preview.unchanged > 0) {
      box.createEl("p", {
        text: `${preview.unchanged} file(s) already match and are not listed.`,
        cls: "setting-item-description",
      });
    }

    const buttons = bodyEl.createDiv({ cls: "modal-button-container" });
    const go = buttons.createEl("button", {
      text: "Restore",
      cls: summary.touchesVault ? "mod-warning" : "mod-cta",
    });
    go.disabled = selection.selectedCount === 0;
    go.addEventListener("click", () => void this.restore(summary.touchesVault, summary.lines));
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  private renderGroup(parent: HTMLElement, selection: RestoreSelection, group: PreviewGroup): void {
    const rows = selection.rows(group);
    if (rows.length === 0) return;
    const section = parent.createDiv();
    const header = section.createEl("label", { cls: "rewind-vault-group-header" });
    const all = header.createEl("input", { type: "checkbox" });
    const state = selection.groupState(group);
    all.checked = state === "all";
    all.indeterminate = state === "some";
    all.addEventListener("change", () => {
      selection.setGroup(group, all.checked);
      this.render();
    });
    header.createEl("strong", { text: ` ${GROUP_TITLES[group]}: ${rows.length}` });

    const list = section.createDiv({ cls: "rewind-vault-file-list" });
    for (const row of rows.slice(0, MAX_ROWS_SHOWN)) {
      const line = list.createEl("label", { cls: "rewind-vault-file-row" });
      const box = line.createEl("input", { type: "checkbox" });
      box.checked = selection.isSelected(row.path);
      box.addEventListener("change", () => {
        selection.toggle(row.path);
        this.render();
      });
      const size =
        row.currentSize === undefined
          ? formatBytes(row.size)
          : `${formatBytes(row.currentSize)} to ${formatBytes(row.size)}`;
      line.createSpan({ text: ` ${row.path}  (${size})` });
    }
    if (rows.length > MAX_ROWS_SHOWN) {
      section.createEl("p", {
        text: `…and ${rows.length - MAX_ROWS_SHOWN} more. The checkbox above covers all of them.`,
        cls: "setting-item-description",
      });
    }
  }

  private async restore(touchesVault: boolean, lines: string[]): Promise<void> {
    const choice = this.selection ? chooseRestore(this.selection) : null;
    if (!choice) return;
    if (touchesVault) {
      const ok = await this.host.confirm(
        "Restore into your vault",
        lines.join("\n\n"),
        "Restore",
        true,
      );
      if (!ok) return;
    }
    this.close();
    await this.host.actions.run(this.backupId, this.destination, choice);
  }
}
