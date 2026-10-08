import { Modal, type App } from "obsidian";
import { encodeQr } from "../helpers/qr";

const MODULE_PX = 6;
const QUIET_MODULES = 4;

/**
 * Shows text as a QR code. Scan it with the other device's camera app, copy the text it finds,
 * and use "Import settings from the clipboard" there. Drawn black on white whatever the theme,
 * because scanners need the contrast.
 */
export class QrModal extends Modal {
  constructor(
    app: App,
    private readonly text: string,
    private readonly copy: (text: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Settings QR code");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text:
        "Scan this with the camera of the device you want to copy the settings to, copy the text " +
        'it shows, then run "Import settings from the clipboard" there. Your backup passphrase is not included.',
    });
    const matrix = encodeQr(new TextEncoder().encode(this.text));
    const modules = matrix.length + QUIET_MODULES * 2;
    const canvas = contentEl.createEl("canvas");
    canvas.width = canvas.height = modules * MODULE_PX;
    canvas.setCssProps({ display: "block", margin: "0 auto", maxWidth: "100%", height: "auto" });
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#000000";
      matrix.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (dark) {
            context.fillRect(
              (x + QUIET_MODULES) * MODULE_PX,
              (y + QUIET_MODULES) * MODULE_PX,
              MODULE_PX,
              MODULE_PX,
            );
          }
        }),
      );
    }
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: "Copy the text instead" })
      .addEventListener("click", () => void this.copy(this.text));
    buttons
      .createEl("button", { text: "Close", cls: "mod-cta" })
      .addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
