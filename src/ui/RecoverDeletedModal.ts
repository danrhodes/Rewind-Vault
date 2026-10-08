import { Modal, type App } from "obsidian";
import type { DeletedFile } from "../core/RestoreEngine";
import type { RestoreDestination } from "../core/RestoreTypes";
import { formatLocalDateTime } from "./backupBrowserModel";
import type { Notifier } from "./notify";
import { describeDeleted, filterDeleted, groupByBackup } from "./recoverModel";

export interface RecoverHost {
  listDeleted(): Promise<DeletedFile[]>;
  /** Restore these paths from one backup. True when it completed. */
  recover(backupId: string, paths: string[], destination: RestoreDestination): Promise<boolean>;
  notifier: Notifier;
}

/** Rows drawn. Selection and the buttons still cover every ticked file. */
const MAX_ROWS_SHOWN = 300;

/**
 * Lists files the backups know were deleted and are still missing from the vault, so they
 * can be ticked and brought back: into the vault (nothing there to overwrite) or into the
 * restore folder. Filtering and grouping come from recoverModel.ts (unit tested).
 */
export class RecoverDeletedModal extends Modal {
  private files: DeletedFile[] = [];
  private query = "";
  private readonly chosen = new Set<string>();
  private listEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly host: RecoverHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Recover deleted files");
    const { contentEl } = this;
    contentEl.empty();
    const search = contentEl.createEl("input", { type: "search", placeholder: "Search by path…" });
    search.addClass("rewind-vault-search");
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    this.summaryEl = contentEl.createEl("p", { text: "Reading backups…" });
    this.listEl = contentEl.createDiv();
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: "Recover to my vault", cls: "mod-cta" })
      .addEventListener("click", () => void this.recover({ kind: "vault" }));
    buttons
      .createEl("button", { text: "Recover to the restore folder" })
      .addEventListener("click", () => void this.recover({ kind: "restore-folder" }));
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.listEl = this.summaryEl = null;
  }

  private async load(): Promise<void> {
    try {
      this.files = await this.host.listDeleted();
    } catch (error) {
      this.host.notifier.failure("Reading the deleted files", error);
    }
    this.renderList();
  }

  private renderList(): void {
    if (!this.listEl) return;
    const shown = filterDeleted(this.files, this.query);
    this.summaryEl?.setText(describeDeleted(shown.length, this.files.length, this.chosen.size));
    this.listEl.empty();
    for (const file of shown.slice(0, MAX_ROWS_SHOWN)) {
      const row = this.listEl.createDiv({ cls: "rewind-vault-backup-row" });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = this.chosen.has(file.path);
      box.addEventListener("change", () => {
        if (box.checked) this.chosen.add(file.path);
        else this.chosen.delete(file.path);
        this.summaryEl?.setText(describeDeleted(shown.length, this.files.length, this.chosen.size));
      });
      const text = row.createDiv();
      text.createEl("strong", { text: file.path });
      text.createEl("div", {
        text: `Deleted ${formatLocalDateTime(file.deletedAt)}`,
        cls: "setting-item-description",
      });
    }
    if (shown.length > MAX_ROWS_SHOWN) {
      this.listEl.createEl("p", {
        text: `…and ${shown.length - MAX_ROWS_SHOWN} more. Search to narrow.`,
      });
    }
  }

  private async recover(destination: RestoreDestination): Promise<void> {
    const groups = groupByBackup(this.files, this.chosen);
    if (groups.length === 0) {
      this.host.notifier.info("Tick the files to recover first.");
      return;
    }
    for (const group of groups) {
      if (!(await this.host.recover(group.backupId, group.paths, destination))) return;
    }
    this.close();
  }
}
