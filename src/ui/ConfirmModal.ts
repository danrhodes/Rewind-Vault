import { Modal, type App } from "obsidian";

/**
 * Yes/no dialog. Resolves true only when the confirm button is pressed; closing the dialog
 * any other way (Esc, X, Cancel) resolves false.
 */
export class ConfirmModal extends Modal {
  private result = false;
  private settle: (value: boolean) => void = () => undefined;
  private readonly answer = new Promise<boolean>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly dangerous: boolean,
  ) {
    super(app);
  }

  /** Open the dialog and wait for the answer. */
  ask(): Promise<boolean> {
    this.open();
    return this.answer;
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    for (const paragraph of this.message.split("\n\n"))
      contentEl.createEl("p", { text: paragraph });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const confirm = buttons.createEl("button", {
      text: this.confirmLabel,
      cls: this.dangerous ? "mod-warning" : "mod-cta",
    });
    confirm.addEventListener("click", () => {
      this.result = true;
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    this.settle(this.result);
  }
}
