import { Modal, type App } from "obsidian";
import type { FileVersion } from "../core/FileVersions";
import { sha256Hex } from "../crypto/hash";
import { formatLocalDateTime } from "./backupBrowserModel";
import { describeFileDiff } from "./diffModel";
import type { Notifier } from "./notify";
import { buildVersionRows, describeTimeline, type VersionRow } from "./timeMachineModel";

export interface TimeMachineHost {
  listVersions(path: string): Promise<FileVersion[]>;
  readBackupFile(backupId: string, path: string): Promise<Uint8Array>;
  /** The file in the vault now, or null when it does not exist. */
  readLiveFile(path: string): Promise<Uint8Array | null>;
  /** Restore that version next to the vault (restore folder). Never touches the note. */
  restoreCopy(backupId: string, path: string): Promise<boolean>;
  /** Put that version back in the vault, replacing the note. */
  replaceNote(backupId: string, path: string): Promise<boolean>;
  confirm(
    title: string,
    message: string,
    confirmLabel: string,
    dangerous: boolean,
  ): Promise<boolean>;
  notifier: Notifier;
}

/**
 * Every saved version of one note across all backups, newest first. For each: see what differs
 * from the note now, restore a copy to the restore folder, or put it back in place of the
 * note. Text and ordering come from timeMachineModel.ts and diffModel.ts (unit tested).
 */
export class TimeMachineModal extends Modal {
  private diffEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly path: string,
    private readonly host: TimeMachineHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Time machine");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Reading backups…", cls: "setting-item-description" });
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.diffEl = null;
  }

  private async load(): Promise<void> {
    try {
      const live = await this.host.readLiveFile(this.path);
      const rows = buildVersionRows(
        await this.host.listVersions(this.path),
        live ? sha256Hex(live) : null,
        formatLocalDateTime,
      );
      const { contentEl } = this;
      contentEl.empty();
      contentEl.createEl("p", {
        text: describeTimeline(this.path, rows),
        cls: "setting-item-description",
      });
      for (const row of rows) this.renderRow(contentEl, row);
      this.diffEl = contentEl.createEl("pre");
    } catch (error) {
      this.contentEl.empty();
      this.host.notifier.failure("Reading the backup history", error);
      this.contentEl.createEl("p", { text: "The history could not be read." });
    }
  }

  private renderRow(parent: HTMLElement, row: VersionRow): void {
    const el = parent.createDiv({ cls: "rewind-vault-backup-row" });
    const text = el.createDiv();
    text.createEl("strong", { text: row.title });
    text.createEl("div", { text: row.detail, cls: "setting-item-description" });
    if (row.kind === "deleted") return;
    const buttons = el.createDiv({ cls: "rewind-vault-backup-actions" });
    const add = (label: string, run: () => Promise<void>, warn = false): void => {
      const button = buttons.createEl("button", { text: label, cls: warn ? "mod-warning" : "" });
      button.addEventListener("click", () => void run());
    };
    add("Show changes", () => this.showDiff(row));
    add("Restore copy", async () => void (await this.host.restoreCopy(row.backupId, this.path)));
    if (!row.isCurrent) add("Replace note", () => this.replace(row), true);
  }

  private async replace(row: VersionRow): Promise<void> {
    const ok = await this.host.confirm(
      "Replace note",
      `Replace ${this.path} with the version from ${row.title}? ` +
        "The current content is saved in a safety backup first when that setting is on.",
      "Replace",
      true,
    );
    if (!ok) return;
    if (await this.host.replaceNote(row.backupId, this.path)) this.close();
  }

  private async showDiff(row: VersionRow): Promise<void> {
    const target = this.diffEl;
    if (!target) return;
    target.empty();
    try {
      const backup = await this.host.readBackupFile(row.backupId, this.path);
      const live = await this.host.readLiveFile(this.path);
      const view = describeFileDiff(this.path, backup, live);
      if (view.kind === "unavailable") {
        target.setText(view.reason);
        return;
      }
      target.createEl("div", {
        text: `${view.removed} line(s) only in this version (-), ${view.added} only in the note now (+)`,
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
      this.host.notifier.failure("Reading that version", error);
    }
  }
}
