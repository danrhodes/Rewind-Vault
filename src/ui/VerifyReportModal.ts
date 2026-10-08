import { Modal, type App } from "obsidian";
import type { VerifyReport } from "../types";
import { describeReport, reportToText } from "./verifyReportModel";

/** Shows the outcome of a verification. All wording comes from verifyReportModel.ts. */
export class VerifyReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: VerifyReport,
    private readonly copy: (text: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const view = describeReport(this.report);
    this.titleEl.setText(`Verification: ${view.headline}`);
    const { contentEl } = this;
    contentEl.empty();
    this.list(view.summary);
    if (view.rehearsal.length > 0) this.section("Rehearsal", view.rehearsal);
    if (view.issues.length > 0) {
      this.section(
        "Problems",
        view.issues.map((i) => i.text),
        true,
      );
    }
    if (view.skipped.length > 0) this.section("Skipped checks", view.skipped);
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: "Copy report" })
      .addEventListener("click", () => void this.copy(reportToText(this.report)));
    buttons.createEl("button", { text: "Close", cls: "mod-cta" }).addEventListener("click", () => {
      this.close();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private section(title: string, lines: string[], problem = false): void {
    this.contentEl.createEl("h4", { text: title });
    this.list(lines, problem);
  }

  private list(lines: string[], problem = false): void {
    const ul = this.contentEl.createEl("ul");
    for (const line of lines) {
      ul.createEl("li", { text: line, cls: problem ? "mod-warning" : "" });
    }
  }
}
