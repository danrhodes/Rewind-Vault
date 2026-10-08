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
  /** Rewrite the status note; resolves false when the setting is off or the write failed. */
  refreshStatusNote(): Promise<boolean>;
  massChange: { isPaused(): boolean; summary(): string; release(): void };
}

/** Housekeeping commands that change backup bookkeeping but never delete backups. */
export class MaintenanceActions {
  constructor(private readonly deps: MaintenanceDeps) {}

  /** Let automatic backups run again after the mass-change guard paused them. */
  async resumeAfterMassChange(): Promise<void> {
    const { notifier, massChange } = this.deps;
    if (!massChange.isPaused()) {
      notifier.info("Automatic backups are not paused.");
      return;
    }
    const ok = await this.deps.confirm(
      "Resume automatic backups",
      `Backups were paused because ${massChange.summary()}. Resume only if you know why ` +
        "(a big import, a sync, a planned cleanup). Otherwise check your notes first: a new " +
        "backup of damaged notes could eventually replace the good ones.",
      "Resume",
      true,
    );
    if (!ok) return;
    massChange.release();
    notifier.success("Automatic backups resumed.");
  }

  async updateStatusNote(): Promise<void> {
    const { notifier, refreshStatusNote } = this.deps;
    if (await refreshStatusNote()) notifier.success("Backup status note updated.");
    else notifier.info("The status note is off or could not be written. See the settings and log.");
  }

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
    {
      id: "update-status-note",
      name: "Update the backup status note",
      icon: "activity",
      run: () => actions.updateStatusNote(),
    },
    {
      id: "resume-automatic",
      name: "Resume automatic backups (after a mass-change pause)",
      icon: "play",
      run: () => actions.resumeAfterMassChange(),
    },
  ];
}
