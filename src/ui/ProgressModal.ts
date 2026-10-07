import { Modal, type App } from "obsidian";
import type { RestoreProgress } from "../core/RestoreTypes";
import type { RunProgress } from "../core/RunTypes";
import { systemClock } from "../helpers/time";
import {
  CANCELLING_NOTE,
  CANCEL_LABEL,
  RenderThrottle,
  viewBackupProgress,
  viewRestoreProgress,
  type CancelSource,
  type ProgressView,
} from "./progressModel";

/**
 * Cancellable progress dialog for backups and restores. Closing it (Esc, X) only hides it: the
 * operation keeps running; only the Cancel button cancels. The Obsidian-facing shell is thin
 * on purpose, all text and numbers come from progressModel.ts, which is unit tested.
 */
export class ProgressModal extends Modal {
  private bar: HTMLProgressElement | null = null;
  private headingEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private fileEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private latest: ProgressView | null = null;
  private readonly throttle = new RenderThrottle(() => systemClock.now());

  constructor(
    app: App,
    private readonly title: string,
    private readonly cancel: CancelSource,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    this.headingEl = contentEl.createEl("p", { cls: "rewind-vault-progress-heading" });
    this.bar = contentEl.createEl("progress", { cls: "rewind-vault-progress-bar" });
    this.bar.max = 1;
    this.detailEl = contentEl.createEl("p", { cls: "rewind-vault-progress-detail" });
    this.fileEl = contentEl.createEl("p", { cls: "rewind-vault-progress-file mod-muted" });
    this.noteEl = contentEl.createEl("p", { cls: "rewind-vault-progress-note" });
    this.cancelButton = contentEl.createEl("button", { text: CANCEL_LABEL, cls: "mod-warning" });
    this.cancelButton.addEventListener("click", () => this.requestCancel());
    if (this.cancel.isCancelled()) this.showCancelling();
    if (this.latest) this.draw(this.latest);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.bar = this.headingEl = this.detailEl = this.fileEl = this.noteEl = null;
    this.cancelButton = null;
  }

  updateBackup(progress: RunProgress): void {
    this.show(viewBackupProgress(progress));
  }

  updateRestore(progress: RestoreProgress): void {
    this.show(viewRestoreProgress(progress));
  }

  /** Call when the operation ends, successfully or not. */
  finish(): void {
    this.close();
  }

  private show(view: ProgressView): void {
    this.latest = view;
    if (!this.throttle.shouldRender()) return;
    this.draw(view);
  }

  private draw(view: ProgressView): void {
    this.headingEl?.setText(view.heading);
    this.detailEl?.setText(view.detail);
    this.fileEl?.setText(view.currentFile ?? "");
    if (!this.bar) return;
    if (view.fraction === null) this.bar.removeAttribute("value");
    else this.bar.value = view.fraction;
  }

  private requestCancel(): void {
    this.cancel.cancel();
    this.showCancelling();
  }

  private showCancelling(): void {
    this.noteEl?.setText(CANCELLING_NOTE);
    if (this.cancelButton) this.cancelButton.disabled = true;
  }
}
