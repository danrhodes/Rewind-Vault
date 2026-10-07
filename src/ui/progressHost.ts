import type { App } from "obsidian";
import type { ProgressUi } from "../commands/actions";
import { ProgressModal } from "./ProgressModal";

/** Opens a ProgressModal for the commands. The only place that connects them to Obsidian. */
export function createProgressUi(app: App): ProgressUi {
  return {
    open(title, cancel) {
      const modal = new ProgressModal(app, title, cancel);
      modal.open();
      return {
        updateBackup: (progress) => modal.updateBackup(progress),
        updateRestore: (progress) => modal.updateRestore(progress),
        close: () => modal.finish(),
      };
    },
  };
}
