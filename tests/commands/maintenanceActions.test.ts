import { describe, expect, it, vi } from "vitest";
import { BusyFlag } from "../../src/commands/actions";
import {
  MaintenanceActions,
  buildMaintenanceCommands,
} from "../../src/commands/maintenanceActions";
import { createDefaultProfile } from "../../src/settings/defaults";
import { Notifier } from "../../src/ui/notify";

let repairResult: unknown = {
  backupId: "B1",
  repaired: [],
  intact: ["p"],
  failed: [],
  healed: false,
};

function setup(answer = true, fail = false, paused = false, noteWritten = true) {
  const profile = createDefaultProfile("desktop");
  profile.notifications.level = "verbose";
  const notices: string[] = [];
  const repairBackup = vi.fn(async (): Promise<unknown> => repairResult);
  const resetState = vi.fn(async () => {
    if (fail) throw new Error("locked");
  });
  const busy = new BusyFlag();
  const massChange = {
    paused,
    isPaused: () => massChange.paused,
    summary: () => "300 files changed within 60 seconds",
    release: vi.fn(() => {
      massChange.paused = false;
    }),
  };
  const actions = new MaintenanceActions({
    admin: () => ({ resetState, repairBackup }) as never,
    confirm: async () => answer,
    notifier: new Notifier(
      (m) => notices.push(m),
      () => profile,
    ),
    busy,
    massChange,
    refreshStatusNote: async () => noteWritten,
  });
  return { actions, resetState, repairBackup, notices, busy, massChange };
}

describe("MaintenanceActions.resetState", () => {
  it("resets after confirmation and frees the busy flag", async () => {
    const t = setup();
    await t.actions.resetState();
    expect(t.resetState).toHaveBeenCalledTimes(1);
    expect(t.notices.join()).toContain("next backup will be a full backup");
    expect(t.busy.isBusy).toBe(false);
  });

  it("does nothing when declined", async () => {
    const t = setup(false);
    await t.actions.resetState();
    expect(t.resetState).not.toHaveBeenCalled();
    expect(t.busy.isBusy).toBe(false);
  });

  it("reports a failure and frees the busy flag", async () => {
    const t = setup(true, true);
    await t.actions.resetState();
    expect(t.notices.join()).toContain("locked");
    expect(t.busy.isBusy).toBe(false);
  });

  it("is refused while another operation runs", async () => {
    const t = setup();
    t.busy.tryAcquire();
    await t.actions.resetState();
    expect(t.resetState).not.toHaveBeenCalled();
    expect(t.notices.join()).toContain("already running");
    expect(t.busy.isBusy).toBe(true);
  });

  it("has palette commands", () => {
    expect(buildMaintenanceCommands(setup().actions).map((c) => c.id)).toEqual([
      "reset-state",
      "update-status-note",
      "resume-automatic",
    ]);
  });
});

describe("MaintenanceActions.resumeAfterMassChange", () => {
  it("releases the guard after confirmation", async () => {
    const t = setup(true, false, true);
    await t.actions.resumeAfterMassChange();
    expect(t.massChange.release).toHaveBeenCalledTimes(1);
    expect(t.notices.join()).toContain("resumed");
  });

  it("keeps the pause when declined", async () => {
    const t = setup(false, false, true);
    await t.actions.resumeAfterMassChange();
    expect(t.massChange.release).not.toHaveBeenCalled();
    expect(t.massChange.isPaused()).toBe(true);
  });

  it("says so when nothing is paused", async () => {
    const t = setup(true, false, false);
    await t.actions.resumeAfterMassChange();
    expect(t.massChange.release).not.toHaveBeenCalled();
    expect(t.notices.join()).toContain("not paused");
  });
});

describe("MaintenanceActions.updateStatusNote", () => {
  it("confirms when the note was written", async () => {
    const t = setup();
    await t.actions.updateStatusNote();
    expect(t.notices.join()).toContain("status note updated");
  });

  it("explains when it was not written", async () => {
    const t = setup(true, false, false, false);
    await t.actions.updateStatusNote();
    expect(t.notices.join()).toContain("off or could not be written");
  });
});

describe("MaintenanceActions.repairBackup", () => {
  const report = (extra: object) => ({
    backupId: "B1",
    repaired: [],
    intact: [],
    failed: [],
    healed: false,
    ...extra,
  });

  it("says when the backup is intact and when it was repaired", async () => {
    repairResult = report({ intact: ["p"] });
    const a = setup();
    await a.actions.repairBackup("B1");
    expect(a.notices.join()).toContain("Nothing needed repairing");
    repairResult = report({ repaired: ["part-001.zip"], healed: true });
    const b = setup();
    await b.actions.repairBackup("B1");
    expect(b.notices.join()).toContain("intact again");
    expect(b.busy.isBusy).toBe(false);
  });

  it("reports parts that could not be repaired as an error", async () => {
    repairResult = report({ failed: [{ part: "part-001.zip", reason: "too much damage" }] });
    const t = setup();
    await t.actions.repairBackup("B1");
    expect(t.notices.join()).toContain("part-001.zip: too much damage");
  });

  it("is refused while busy, and a failure is reported", async () => {
    const t = setup();
    t.busy.tryAcquire();
    await t.actions.repairBackup("B1");
    expect(t.repairBackup).not.toHaveBeenCalled();
    t.busy.release();
    repairResult = null;
    t.repairBackup.mockRejectedValueOnce(new Error("locked"));
    await t.actions.repairBackup("B1");
    expect(t.notices.join()).toContain("locked");
  });
});
