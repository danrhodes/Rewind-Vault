import type { BackupAdmin } from "../core/BackupAdmin";
import type { Notifier } from "../ui/notify";
import type { CommandDef } from "./definitions";

export const MAX_MILESTONE_NAME = 80;

/** Trim, collapse whitespace and cap the length. An empty result means "no name". */
export function normaliseMilestoneName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_MILESTONE_NAME).trim();
}

export interface MilestoneDeps {
  /** A full backup, kept as a milestone. Resolves to the new backup id, or null if none was made. */
  backupForMilestone(): Promise<string | null>;
  admin(): BackupAdmin;
  /** Ask for the milestone name; null when cancelled. */
  askName(title: string, message: string): Promise<string | null>;
  notifier: Notifier;
}

/** Create named milestones: backups that retention never removes. */
export class MilestoneActions {
  constructor(private readonly deps: MilestoneDeps) {}

  /** Ask for a name, make a full backup, pin it under that name. */
  async create(): Promise<void> {
    const { notifier } = this.deps;
    const raw = await this.deps.askName(
      "Create a milestone",
      'Name this point in time (for example "Before the thesis rewrite"). A full backup is ' +
        "made now and kept until you unpin or delete it.",
    );
    if (raw === null) return;
    try {
      const id = await this.deps.backupForMilestone();
      if (id === null) return; // the backup already told the user why
      await this.deps.admin().setPinned(id, true, normaliseMilestoneName(raw));
      notifier.success(`Milestone saved: ${normaliseMilestoneName(raw) || id}.`);
    } catch (error) {
      notifier.failure("Saving the milestone", error);
    }
  }
}

export function buildMilestoneCommands(actions: MilestoneActions): CommandDef[] {
  return [
    {
      id: "create-milestone",
      name: "Create a named milestone (full backup, kept)",
      icon: "flag",
      run: () => actions.create(),
    },
  ];
}
