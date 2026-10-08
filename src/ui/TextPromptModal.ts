import { Modal, type App } from "obsidian";

/**
 * Asks for one line of text. Resolves to the text (possibly empty), or null if the dialog is
 * cancelled or closed. Enter confirms.
 */
export class TextPromptModal extends Modal {
  private result: string | null = null;
  private settle: (value: string | null) => void = () => undefined;
  private readonly answer = new Promise<string | null>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly placeholder: string,
    private readonly confirmLabel: string,
  ) {
    super(app);
  }

  ask(): Promise<string | null> {
    this.open();
    return this.answer;
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });
    const input = contentEl.createEl("input", { type: "text", placeholder: this.placeholder });
    const submit = (): void => {
      this.result = input.value;
      this.close();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: this.confirmLabel, cls: "mod-cta" })
      .addEventListener("click", submit);
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    input.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.settle(this.result);
  }
}
