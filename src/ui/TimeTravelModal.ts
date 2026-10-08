import { Modal, type App } from "obsidian";
import type { PointFile } from "../core/TimeTravel";
import type { BackupEntry } from "../types";
import { formatLocalDateTime } from "./backupBrowserModel";
import type { Notifier } from "./notify";
import {
  MAX_ROWS,
  buildPreview,
  describeFileRow,
  describeListing,
  filterFiles,
} from "./timeTravelModel";

export interface TimeTravelHost {
  listPoints(): Promise<BackupEntry[]>;
  listFiles(backupId: string): Promise<PointFile[]>;
  readFile(backupId: string, path: string): Promise<Uint8Array>;
  notifier: Notifier;
}

/**
 * Look at the vault as it was at any intact backup. Strictly read-only: it lists files and
 * shows text previews, and has no button that writes anything (use Browse backups to restore).
 */
export class TimeTravelModal extends Modal {
  private files: PointFile[] = [];
  private backupId = "";
  private query = "";
  private listEl: HTMLElement | null = null;
  private infoEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private token = 0;

  constructor(
    app: App,
    private readonly host: TimeTravelHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Vault time travel (read-only)");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Reading backups…", cls: "setting-item-description" });
    void this.load();
  }

  override onClose(): void {
    this.token++;
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      const points = await this.host.listPoints();
      const { contentEl } = this;
      contentEl.empty();
      const first = points[0];
      if (!first) {
        contentEl.createEl("p", { text: "There are no intact backups to look at yet." });
        return;
      }
      const select = contentEl.createEl("select");
      for (const p of points) {
        const label = `${formatLocalDateTime(p.createdAt)} (${p.type}${p.pinned ? ", pinned" : ""})`;
        select.createEl("option", { text: label, value: p.id });
      }
      select.addEventListener("change", () => void this.pick(select.value));
      const search = contentEl.createEl("input", { type: "text" });
      search.placeholder = "Search by path";
      search.addEventListener("input", () => {
        this.query = search.value;
        this.renderList();
      });
      this.infoEl = contentEl.createEl("p", { cls: "setting-item-description" });
      this.listEl = contentEl.createDiv();
      this.previewEl = contentEl.createEl("pre");
      await this.pick(first.id);
    } catch (error) {
      this.contentEl.empty();
      this.host.notifier.failure("Reading the backup history", error);
      this.contentEl.createEl("p", { text: "The backups could not be read." });
    }
  }

  private async pick(backupId: string): Promise<void> {
    const mine = ++this.token;
    this.backupId = backupId;
    this.previewEl?.empty();
    this.infoEl?.setText("Reading the file list…");
    this.listEl?.empty();
    try {
      const files = await this.host.listFiles(backupId);
      if (mine !== this.token) return;
      this.files = files;
      this.renderList();
    } catch (error) {
      if (mine !== this.token) return;
      this.host.notifier.failure("Reading that backup", error);
      this.infoEl?.setText("That backup could not be read.");
    }
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const matched = filterFiles(this.files, this.query);
    const shown = matched.slice(0, MAX_ROWS);
    this.infoEl?.setText(describeListing(this.files.length, matched.length, shown.length));
    for (const file of shown) {
      const row = list.createDiv({ cls: "rewind-vault-backup-row" });
      const text = row.createDiv();
      text.createEl("strong", { text: file.path });
      text.createEl("div", {
        text: describeFileRow(file, formatLocalDateTime),
        cls: "setting-item-description",
      });
      const view = row.createEl("button", { text: "View" });
      view.addEventListener("click", () => void this.view(file.path));
    }
  }

  private async view(path: string): Promise<void> {
    const target = this.previewEl;
    if (!target) return;
    const mine = this.token;
    target.empty();
    try {
      const data = await this.host.readFile(this.backupId, path);
      if (mine !== this.token) return;
      const preview = buildPreview(path, data);
      if (preview.kind === "unavailable") {
        target.setText(preview.reason);
        return;
      }
      target.setText(preview.text + (preview.truncated ? "\n… (shortened)" : ""));
    } catch (error) {
      this.host.notifier.failure("Reading that file", error);
      target.setText("The file could not be read.");
    }
  }
}
