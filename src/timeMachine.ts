import type { App } from "obsidian";
import type { RestoreActions } from "./commands/restoreActions";
import type { CommandDef } from "./commands/definitions";
import type { Services } from "./services";
import { RecoverDeletedModal } from "./ui/RecoverDeletedModal";
import { TimeMachineModal } from "./ui/TimeMachineModal";

type Confirm = (
  title: string,
  message: string,
  confirmLabel: string,
  dangerous: boolean,
) => Promise<boolean>;

/** The "Time machine for the current note" command. Connects the dialog to the engines. */
export function buildTimeMachineCommands(
  app: App,
  services: Services,
  restoreActions: RestoreActions,
  confirm: Confirm,
): CommandDef[] {
  const { store, restore, notifier } = services;
  return [
    {
      id: "time-machine",
      name: "Time machine for the current note",
      icon: "history",
      run: () => {
        const file = app.workspace.getActiveFile();
        if (!file) {
          notifier.info("Open a note first.");
          return;
        }
        new TimeMachineModal(app, file.path, {
          listVersions: (path) => restore.listFileVersions(path),
          readBackupFile: (backupId, path) => restore.readFile({ id: backupId }, path),
          readLiveFile: async (path) =>
            (await store.exists(path)) ? store.readBinary(path) : null,
          restoreCopy: (backupId, path) =>
            restoreActions.run(
              backupId,
              { kind: "restore-folder" },
              { kind: "files", paths: [path], overwrite: true },
            ),
          replaceNote: (backupId, path) =>
            restoreActions.run(
              backupId,
              { kind: "vault" },
              { kind: "files", paths: [path], overwrite: true },
            ),
          confirm,
          notifier,
        }).open();
      },
    },
  ];
}

/** The "Recover deleted files" command. */
export function buildRecoveryCommands(
  app: App,
  services: Services,
  restoreActions: RestoreActions,
): CommandDef[] {
  const { restore, notifier } = services;
  return [
    {
      id: "recover-deleted",
      name: "Recover deleted files",
      icon: "undo-2",
      run: () =>
        new RecoverDeletedModal(app, {
          listDeleted: () => restore.listDeleted(),
          recover: (backupId, paths, destination) =>
            restoreActions.run(backupId, destination, { kind: "files", paths, overwrite: false }),
          notifier,
        }).open(),
    },
  ];
}
