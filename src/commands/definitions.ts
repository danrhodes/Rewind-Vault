import type { SettingsProfile } from "../types";
import type { Actions } from "./actions";

/** Opens screens that later UI tasks provide. Required, so none can be forgotten. */
export interface UiActions {
  /** Opens the backup list, from which backups are restored, verified, pinned and deleted. */
  openBackupBrowser(): void;
}

export interface CommandDef {
  /** Obsidian prefixes the id with the plugin id and the name with the plugin name. */
  id: string;
  name: string;
  icon: string;
  /** Hidden from the palette unless the "show legacy commands" setting is on. */
  legacy?: boolean;
  run(): void | Promise<void>;
}

export const RIBBON_ICON = "history";
export const RIBBON_TITLE = "Rewind Vault: back up now";

/**
 * The command palette entries. Obsidian shows each as "Rewind Vault: <name>", so the names
 * here do not repeat the plugin name.
 */
export function buildCommands(actions: Actions, ui: UiActions): CommandDef[] {
  return [
    { id: "backup-now", name: "Back up now", icon: "history", run: () => actions.backupNow() },
    {
      id: "backup-full",
      name: "Back up now (full)",
      icon: "archive",
      run: () => actions.backupFull(),
    },
    {
      id: "backup-differential",
      name: "Back up now (differential)",
      icon: "archive",
      run: () => actions.backupDifferential(),
    },
    {
      id: "restore",
      name: "Restore from a backup…",
      icon: "rotate-ccw",
      run: () => ui.openBackupBrowser(),
    },
    {
      id: "browse-backups",
      name: "Browse backups",
      icon: "list",
      run: () => ui.openBackupBrowser(),
    },
    {
      id: "verify-latest",
      name: "Verify the latest backup",
      icon: "shield-check",
      run: () => actions.verifyLatest(3),
    },
    {
      id: "backup-non-destructive",
      name: "Back up now (non-destructive)",
      icon: "archive",
      legacy: true,
      run: () => actions.backupNonDestructive(),
    },
    {
      id: "resume-backup",
      name: "Resume an interrupted backup",
      icon: "play",
      legacy: true,
      run: () => actions.resumeInterrupted(),
    },
    {
      id: "verify-chain",
      name: "Verify the latest backup and its chain (deep)",
      icon: "shield-check",
      legacy: true,
      run: () => actions.verifyLatest(5),
    },
    {
      id: "verify-rehearsal",
      name: "Rehearse a restore of the latest backup",
      icon: "shield-check",
      legacy: true,
      run: () => actions.verifyLatest(6),
    },
  ];
}

/** Whether a command appears in the palette right now. Read each time the palette opens. */
export function isCommandAvailable(def: CommandDef, profile: SettingsProfile): boolean {
  return !def.legacy || profile.basic.showLegacyCommands;
}
