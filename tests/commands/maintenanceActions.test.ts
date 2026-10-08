import { describe, expect, it, vi } from "vitest";
import { BusyFlag } from "../../src/commands/actions";
import {
  MaintenanceActions,
  buildMaintenanceCommands,
} from "../../src/commands/maintenanceActions";
import { createDefaultProfile } from "../../src/settings/defaults";
import { Notifier } from "../../src/ui/notify";

function setup(answer = true, fail = false) {
  const profile = createDefaultProfile("desktop");
  profile.notifications.level = "verbose";
  const notices: string[] = [];
  const resetState = vi.fn(async () => {
    if (fail) throw new Error("locked");
  });
  const busy = new BusyFlag();
  const actions = new MaintenanceActions({
    admin: () => ({ resetState }) as never,
    confirm: async () => answer,
    notifier: new Notifier(
      (m) => notices.push(m),
      () => profile,
    ),
    busy,
  });
  return { actions, resetState, notices, busy };
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

  it("has a palette command", () => {
    expect(buildMaintenanceCommands(setup().actions).map((c) => c.id)).toEqual(["reset-state"]);
  });
});
