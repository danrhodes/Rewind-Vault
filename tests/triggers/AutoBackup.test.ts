import { describe, expect, it, vi } from "vitest";
import type { RunResult } from "../../src/core/RunTypes";
import { LockError } from "../../src/helpers/errors";
import { createDefaultProfile } from "../../src/settings/defaults";
import { createAutoBackup } from "../../src/triggers/AutoBackup";
import type { ConditionResult } from "../../src/triggers/Conditions";
import { Notifier } from "../../src/ui/notify";
import { MockLogger } from "../mocks/MockLogger";

const done: RunResult = {
  status: "completed",
  backupId: "B1",
  type: "diff",
  fileCount: 2,
  bytes: 10,
  skippedFiles: [],
  nonDestructive: false,
};

function setup(
  options: {
    style?: "off" | "full" | "differential" | "non-destructive";
    conditions?: ConditionResult;
    run?: () => Promise<RunResult>;
    busy?: boolean;
    hold?: string | null;
  } = {},
) {
  const profile = createDefaultProfile("desktop");
  profile.basic.autoStyle = options.style ?? "differential";
  profile.notifications.level = "verbose";
  const notices: string[] = [];
  const engineRun = vi.fn(async (o: unknown) => {
    void o;
    return options.run ? options.run() : done;
  });
  const finished: boolean[] = [];
  let held = options.busy ?? false;
  const run = createAutoBackup({
    backup: { run: engineRun },
    conditions: async () => options.conditions ?? { ok: true, blocked: [], unknown: [] },
    notifier: new Notifier(
      (m) => notices.push(m),
      () => profile,
    ),
    logger: new MockLogger(),
    getProfile: () => profile,
    busy: {
      tryAcquire: () => (held ? false : (held = true)),
      release: () => {
        held = false;
      },
    },
    hold: () => options.hold ?? null,
    status: { progress: () => undefined, finished: (ok) => finished.push(ok) },
  });
  return { run, engineRun, notices, finished, isHeld: () => held };
}

describe("createAutoBackup", () => {
  it("runs the configured style and reports success", async () => {
    const t = setup({ style: "full" });
    await t.run("startup");
    expect(t.engineRun.mock.calls[0]?.[0]).toMatchObject({ mode: "full" });
    expect(t.notices.join()).toContain("Backup complete");
    expect(t.finished).toEqual([true]);
    expect(t.isHeld()).toBe(false);
  });

  it("does nothing when the automatic style is off", async () => {
    const t = setup({ style: "off" });
    await t.run("interval");
    expect(t.engineRun).not.toHaveBeenCalled();
    expect(t.finished).toEqual([]);
  });

  it("does not start while another operation holds the busy flag", async () => {
    const t = setup({ busy: true });
    await t.run("interval");
    expect(t.engineRun).not.toHaveBeenCalled();
    expect(t.isHeld()).toBe(true); // not released: it was never ours
  });

  it("holds back when a condition blocks, and frees the flag", async () => {
    const t = setup({
      conditions: { ok: false, blocked: [{ condition: "battery", message: "low" }], unknown: [] },
    });
    await t.run("resume");
    expect(t.engineRun).not.toHaveBeenCalled();
    expect(t.isHeld()).toBe(false);
  });

  it("reports a failure without throwing and marks the status bar", async () => {
    const t = setup({
      run: async () => {
        throw new Error("disk full");
      },
    });
    await expect(t.run("daily")).resolves.toBeUndefined();
    expect(t.notices.join()).toContain("disk full");
    expect(t.finished).toEqual([false]);
    expect(t.isHeld()).toBe(false);
  });

  it("is held back by the mass-change guard without touching the busy flag", async () => {
    const t = setup({ hold: "mass change guard: 300 files changed within 60 seconds" });
    await t.run("interval");
    expect(t.engineRun).not.toHaveBeenCalled();
    expect(t.isHeld()).toBe(false);
    expect(t.finished).toEqual([]);
  });

  it("rethrows a LockError for the run guard", async () => {
    const t = setup({
      run: async () => {
        throw new LockError("held elsewhere");
      },
    });
    await expect(t.run("daily")).rejects.toBeInstanceOf(LockError);
    expect(t.isHeld()).toBe(false);
  });
});
