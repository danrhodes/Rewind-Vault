import type { BackupAdmin } from "../core/BackupAdmin";
import type { Notifier } from "../ui/notify";
import type { BusyFlag } from "./actions";
import type { CommandDef } from "./definitions";

export interface MaintenanceDeps {
  admin(): BackupAdmin;
  confirm(
    title: string,
    message: string,
    confirmLabel: string,
    dangerous: boolean,
  ): Promise<boolean>;
  notifier: Notifier;
  /** Shared with the backup and restore actions: no maintenance during a run. */
  busy: BusyFlag;
}

/** Housekeeping commands that change backup bookkeeping but never delete backups. */
export class MaintenanceActions {
  constructor(private readonly deps: MaintenanceDeps) {}

  async resetState(): Promise<void> {
    const { notifier, busy } = this.deps;
    if (!busy.tryAcquire()) {
      notifier.warning("Another Rewind Vault operation is already running.");
      return;
    }
    try {
      const ok = await this.deps.confirm(
        "Reset backup state",
        "Forget which files the last backup saw? The next backup will be a full backup of " +
          "the whole vault, even if nothing changed. Existing backups are not touched.",
        "Reset",
        false,
      );
      if (!ok) return;
      await this.deps.admin().resetState();
      notifier.success("Backup state reset. The next backup will be a full backup.");
    } catch (error) {
      notifier.failure("Resetting the backup state", error);
    } finally {
      busy.release();
    }
  }
}

export function buildMaintenanceCommands(actions: MaintenanceActions): CommandDef[] {
  return [
    {
      id: "reset-state",
      name: "Reset backup state (next backup will be full)",
      icon: "rotate-ccw",
      run: () => actions.resetState(),
    },
  ];
}
