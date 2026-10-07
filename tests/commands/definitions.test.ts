import { describe, expect, it, vi } from "vitest";
import type { Actions } from "../../src/commands/actions";
import {
  RIBBON_ICON,
  RIBBON_TITLE,
  buildCommands,
  isCommandAvailable,
} from "../../src/commands/definitions";
import { createDefaultProfile } from "../../src/settings/defaults";

function fakeActions() {
  const names = [
    "backupNow",
    "backupFull",
    "backupDifferential",
    "backupNonDestructive",
    "resumeInterrupted",
    "verifyLatest",
  ] as const;
  const fake = Object.fromEntries(
    names.map((n) => [n, vi.fn(async () => undefined)]),
  ) as unknown as {
    [K in (typeof names)[number]]: ReturnType<typeof vi.fn>;
  };
  return fake;
}

function setup() {
  const actions = fakeActions();
  const ui = { openBackupBrowser: vi.fn() };
  return { actions, ui, commands: buildCommands(actions as unknown as Actions, ui) };
}

describe("command palette entries", () => {
  it("has the required entries: backup (full/differential), restore, verify", () => {
    const ids = setup().commands.map((c) => c.id);
    for (const id of [
      "backup-now",
      "backup-full",
      "backup-differential",
      "restore",
      "verify-latest",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("ids are unique, lower-kebab, and names are unique and do not repeat the plugin name", () => {
    const { commands } = setup();
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    expect(new Set(commands.map((c) => c.name)).size).toBe(commands.length);
    for (const c of commands) {
      expect(c.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(c.name.toLowerCase()).not.toContain("rewind vault");
      expect(c.icon.length).toBeGreaterThan(0);
    }
  });

  it("each command runs the right action", async () => {
    const { commands, actions, ui } = setup();
    const run = async (id: string) => commands.find((c) => c.id === id)!.run();
    await run("backup-now");
    await run("backup-full");
    await run("backup-differential");
    await run("backup-non-destructive");
    await run("resume-backup");
    await run("verify-latest");
    await run("verify-chain");
    await run("verify-rehearsal");
    await run("restore");
    await run("browse-backups");
    expect(actions.backupNow).toHaveBeenCalledTimes(1);
    expect(actions.backupFull).toHaveBeenCalledTimes(1);
    expect(actions.backupDifferential).toHaveBeenCalledTimes(1);
    expect(actions.backupNonDestructive).toHaveBeenCalledTimes(1);
    expect(actions.resumeInterrupted).toHaveBeenCalledTimes(1);
    expect(actions.verifyLatest.mock.calls.map((c) => c[0])).toEqual([3, 5, 6]);
    expect(ui.openBackupBrowser).toHaveBeenCalledTimes(2);
  });

  it("legacy commands appear only when the setting is on", () => {
    const { commands } = setup();
    const profile = createDefaultProfile("desktop");
    profile.basic.showLegacyCommands = false;
    const visible = (): string[] =>
      commands.filter((c) => isCommandAvailable(c, profile)).map((c) => c.id);
    expect(visible()).not.toContain("backup-non-destructive");
    expect(visible()).toContain("backup-now");
    profile.basic.showLegacyCommands = true;
    expect(visible()).toEqual(commands.map((c) => c.id));
    expect(commands.filter((c) => c.legacy).length).toBeGreaterThan(0);
  });

  it("the ribbon icon is for backing up now", () => {
    expect(RIBBON_ICON.length).toBeGreaterThan(0);
    expect(RIBBON_TITLE).toContain("back up now");
  });
});
