import { Modal, type App } from "obsidian";
import { describeLinkReport, type LinkChange, type LinkReport } from "../core/LinkReport";

/** Rows drawn per list. The counts in the summary still cover every link. */
const MAX_ROWS_SHOWN = 200;

/** What a restore did to the links between notes: which now point at nothing, which work again. */
export class LinkReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: LinkReport,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Restore link report");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: describeLinkReport(this.report) });
    this.section("Links that are now broken", this.report.broken);
    this.section("Links that work again", this.report.fixed);
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: "Close", cls: "mod-cta" })
      .addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private section(title: string, changes: readonly LinkChange[]): void {
    if (changes.length === 0) return;
    this.contentEl.createEl("h4", { text: `${title} (${changes.length})` });
    const list = this.contentEl.createEl("ul");
    for (const change of changes.slice(0, MAX_ROWS_SHOWN)) {
      list.createEl("li", { text: `${change.source} → [[${change.target}]]` });
    }
    if (changes.length > MAX_ROWS_SHOWN) {
      list.createEl("li", { text: `…and ${changes.length - MAX_ROWS_SHOWN} more.` });
    }
  }
}
