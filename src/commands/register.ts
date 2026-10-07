import type { Plugin } from "obsidian";
import type { SettingsProfile } from "../types";
import { RIBBON_ICON, RIBBON_TITLE, isCommandAvailable, type CommandDef } from "./definitions";

/**
 * Add the commands to the palette and the ribbon icon. Legacy commands are registered always
 * but report themselves unavailable (so they are hidden) until the setting is turned on:
 * Obsidian cannot remove a command at run time. Errors are handled inside the actions.
 */
export function registerCommands(
  plugin: Plugin,
  commands: readonly CommandDef[],
  getProfile: () => SettingsProfile,
  runBackupNow: () => void | Promise<void>,
): void {
  for (const def of commands) {
    plugin.addCommand({
      id: def.id,
      name: def.name,
      icon: def.icon,
      checkCallback: (checking) => {
        if (!isCommandAvailable(def, getProfile())) return false;
        if (!checking) void def.run();
        return true;
      },
    });
  }
  plugin.addRibbonIcon(RIBBON_ICON, RIBBON_TITLE, () => void runBackupNow());
}
