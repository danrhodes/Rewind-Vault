import { Modal, type App } from "obsidian";
import { normaliseMilestoneName } from "../commands/milestoneActions";
import { deleteImpact, type BackupAdmin } from "../core/BackupAdmin";
import type { BackupIndex } from "../types";
import {
  buildRows,
  describeDelete,
  formatLocalDateTime,
  summarize,
  type BackupRow,
} from "./backupBrowserModel";
import type { Notifier } from "./notify";

/** What the browser needs from the plugin. Supplied by main.ts from the services. */
export interface BrowserHost {
  loadIndex(): Promise<BackupIndex>;
  admin(): BackupAdmin;
  verify(backupId: string): Promise<void>;
  /** Open the restore dialog for this backup. */
  restore(backupId: string, createdAt: number): void;
  /** Ask for a name (milestone label); null when cancelled. */
  askName(title: string, message: string): Promise<string | null>;
  /** Open the comparison with the live vault for this backup. */
  compare(backupId: string, createdAt: number): void;
  confirm(
    title: string,
    message: string,
    confirmLabel: string,
    dangerous: boolean,
  ): Promise<boolean>;
  notifier: Notifier;
}

/**
 * Lists backups, newest first, with search and per-backup actions: restore, verify, pin and
 * delete. All text and filtering come from backupBrowserModel.ts and all changes go through
 * BackupAdmin (both unit tested); this class only draws them.
 */
export class BackupBrowserModal extends Modal {
  private index: BackupIndex = { schemaVersion: 1, backups: [] };
  private query = "";
  private listEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly host: BrowserHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Rewind Vault backups");
    const { contentEl } = this;
    contentEl.empty();
    const search = contentEl.createEl("input", {
      type: "search",
      placeholder: "Search by date, label, type, status…",
    });
    search.addClass("rewind-vault-search");
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    this.summaryEl = contentEl.createEl("p", { cls: "setting-item-description" });
    this.listEl = contentEl.createDiv({ cls: "rewind-vault-backup-list" });
    void this.reload();
    search.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.listEl = this.summaryEl = null;
  }

  private async reload(): Promise<void> {
    try {
      this.index = await this.host.loadIndex();
    } catch (error) {
      this.host.notifier.failure("Reading the backup list", error);
    }
    this.renderList();
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.summaryEl?.setText(summarize(this.index));
    this.listEl.empty();
    const rows = buildRows(this.index, this.query);
    if (rows.length === 0) {
      this.listEl.createEl("p", {
        text:
          this.index.backups.length === 0 ? "Nothing to show." : "No backup matches the search.",
      });
      return;
    }
    for (const row of rows) this.renderRow(this.listEl, row);
  }

  private renderRow(parent: HTMLElement, row: BackupRow): void {
    const el = parent.createDiv({ cls: "rewind-vault-backup-row" });
    const text = el.createDiv();
    text.createEl("strong", { text: row.title });
    for (const badge of row.badges) text.createEl("span", { text: ` [${badge}]` });
    text.createEl("div", { text: row.subtitle, cls: "setting-item-description" });

    const buttons = el.createDiv({ cls: "rewind-vault-backup-actions" });
    const add = (label: string, onClick: () => void | Promise<void>, warn = false): void => {
      const button = buttons.createEl("button", { text: label, cls: warn ? "mod-warning" : "" });
      button.addEventListener("click", () => void onClick());
    };
    add("Restore", () => this.restoreRow(row));
    add("Compare", () => this.compareRow(row));
    add("Verify", () => this.host.verify(row.id));
    add(row.pinned ? "Unpin" : "Pin", () => this.togglePin(row));
    add("Delete", () => this.remove(row), true);
  }

  private restoreRow(row: BackupRow): void {
    const entry = this.index.backups.find((b) => b.id === row.id);
    if (entry) this.host.restore(entry.id, entry.createdAt);
  }

  private compareRow(row: BackupRow): void {
    const entry = this.index.backups.find((b) => b.id === row.id);
    if (entry) this.host.compare(entry.id, entry.createdAt);
  }

  private async togglePin(row: BackupRow): Promise<void> {
    try {
      let label: string | undefined;
      if (!row.pinned) {
        const name = await this.host.askName(
          "Pin this backup",
          "Give it a name (optional). Pinned backups are never removed by retention.",
        );
        if (name === null) return;
        label = normaliseMilestoneName(name) || undefined;
      }
      await this.host.admin().setPinned(row.id, !row.pinned, label);
    } catch (error) {
      this.host.notifier.failure("Pinning", error);
    }
    await this.reload();
  }

  private async remove(row: BackupRow): Promise<void> {
    try {
      const impact = deleteImpact(this.index, row.id);
      const prompt = describeDelete(impact, formatLocalDateTime);
      if (!(await this.host.confirm("Delete backup", prompt.message, "Delete", true))) return;
      await this.host
        .admin()
        .deleteBackup(row.id, { cascade: prompt.cascade, force: prompt.force });
      this.host.notifier.success("Backup deleted.");
    } catch (error) {
      this.host.notifier.failure("Deleting the backup", error);
    }
    await this.reload();
  }
}
