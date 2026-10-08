import { Modal, type App } from "obsidian";

/**
 * Asks for a passphrase. Resolves to the text, or null if the dialog is closed or cancelled.
 * With `confirm` the passphrase must be typed twice (used when a new one is being set).
 */
export class PassphraseModal extends Modal {
  private result: string | null = null;
  private settle: (value: string | null) => void = () => undefined;
  private readonly answer = new Promise<string | null>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirm: boolean,
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
    const first = contentEl.createEl("input", { type: "password", placeholder: "Passphrase" });
    const second = this.confirm
      ? contentEl.createEl("input", { type: "password", placeholder: "Type it again" })
      : null;
    const problem = contentEl.createEl("p", { cls: "mod-warning" });
    const submit = (): void => {
      if (first.value === "") {
        problem.setText("Enter a passphrase.");
      } else if (second && second.value !== first.value) {
        problem.setText("The two passphrases do not match.");
      } else {
        this.result = first.value;
        this.close();
      }
    };
    for (const input of [first, second]) {
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
    }
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "OK", cls: "mod-cta" }).addEventListener("click", submit);
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    first.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.settle(this.result);
  }
}
