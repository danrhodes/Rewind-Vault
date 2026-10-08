import { describe, expect, it, vi } from "vitest";
import type { ResumeInfo } from "../../src/core/BackupEngine";
import type { RunResult } from "../../src/core/RunTypes";
import { createDefaultProfile } from "../../src/settings/defaults";
import { createAutoBackup } from "../../src/triggers/AutoBackup";
import type { TriggerReason } from "../../src/triggers/TriggerTypes";
import { Notifier } from "../../src/ui/notify";
import { MockLogger } from "../mocks/MockLogger";

const done: RunResult = {
  status: "completed",
  backupId: "B1",
  type: "full",
  fileCount: 2,
  bytes: 10,
  skippedFiles: [],
  nonDestructive: false,
};
const interrupted: ResumeInfo = {
  backupId: "B0",
  type: "full",
  partsDone: 1,
  partsTotal: 3,
  savedAt: 1,
};

function setup(
  options: { setting?: boolean; found?: ResumeInfo | null; lookupFails?: boolean } = {},
) {
  const profile = createDefaultProfile("mobile");
  profile.triggers.continueInterrupted = options.setting ?? true;
  const run = vi.fn(async () => done);
  const resume = vi.fn(async () => done);
  const findResumable = vi.fn(async () => {
    if (options.lookupFails) throw new Error("unreadable");
    return options.found === undefined ? interrupted : options.found;
  });
  const conditions = vi.fn(async () => ({ ok: true, blocked: [], unknown: [] }));
  const auto = createAutoBackup({
    backup: { run, resume, findResumable },
    conditions,
    notifier: new Notifier(
      () => undefined,
      () => profile,
    ),
    logger: new MockLogger(),
    getProfile: () => profile,
    busy: { tryAcquire: () => true, release: () => undefined },
  });
  return { auto, run, resume, findResumable, conditions };
}

describe("createAutoBackup: continuing an interrupted backup", () => {
  it.each(["startup", "resume"] as TriggerReason[])(
    "continues it on %s instead of starting over",
    async (reason) => {
      const t = setup();
      await t.auto(reason);
      expect(t.resume).toHaveBeenCalledTimes(1);
      expect(t.resume.mock.calls[0]).toMatchObject([{ mode: "full" }]);
      expect(t.run).not.toHaveBeenCalled();
      // The no-changes check must not stop it: the cut-off backup is unfinished work.
      expect(t.conditions).toHaveBeenCalledWith(reason, true);
    },
  );

  it("starts a normal backup when nothing was interrupted", async () => {
    const t = setup({ found: null });
    await t.auto("resume");
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.resume).not.toHaveBeenCalled();
    expect(t.conditions).toHaveBeenCalledWith("resume", false);
  });

  it("does not look for one on other triggers or when the setting is off", async () => {
    const other = setup();
    await other.auto("interval");
    expect(other.findResumable).not.toHaveBeenCalled();
    expect(other.run).toHaveBeenCalledTimes(1);

    const off = setup({ setting: false });
    await off.auto("startup");
    expect(off.findResumable).not.toHaveBeenCalled();
    expect(off.resume).not.toHaveBeenCalled();
    expect(off.run).toHaveBeenCalledTimes(1);
  });

  it("falls back to a fresh backup when the lookup fails", async () => {
    const t = setup({ lookupFails: true });
    await t.auto("startup");
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.resume).not.toHaveBeenCalled();
  });
});
