import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import { DEEP_CHECK_MS, Scheduler, type DeepVerifyJob } from "../../src/triggers/Scheduler";
import { globalTimerHost } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 1, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(rehearsalOn: boolean, deepOn = false) {
  const profile = createDefaultProfile("desktop");
  profile.triggers.intervalEnabled = false;
  profile.verification.scheduledRehearsal = rehearsalOn;
  profile.verification.scheduledDeepVerify = deepOn;
  const mk = (): DeepVerifyJob => ({
    isDue: vi.fn(async () => true),
    run: vi.fn(async () => undefined),
  });
  const deep = mk();
  const rehearsal = mk();
  const scheduler = new Scheduler(
    {
      clock: { now: () => Date.now() },
      logger: new MockLogger(),
      getProfile: () => profile,
      run: async () => undefined,
    },
    globalTimerHost,
    deep,
    rehearsal,
  );
  return { scheduler, profile, deep, rehearsal };
}

describe("scheduled restore rehearsal in the scheduler", () => {
  it("does nothing while the setting is off", async () => {
    const s = setup(false);
    s.scheduler.start();
    expect(s.scheduler.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(3 * DEEP_CHECK_MS);
    expect(s.rehearsal.isDue).not.toHaveBeenCalled();
  });

  it("runs the rehearsal job when due, independently of the deep check", async () => {
    const s = setup(true, false);
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.rehearsal.run).toHaveBeenCalledTimes(1);
    expect(s.deep.run).not.toHaveBeenCalled();
  });

  it("both checks can be on; they never run at the same moment", async () => {
    const s = setup(true, true);
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.deep.run).toHaveBeenCalledTimes(1);
    expect(s.rehearsal.run).toHaveBeenCalledTimes(1);
  });

  it("reconfigure follows the setting", async () => {
    const s = setup(false);
    s.scheduler.start();
    s.profile.verification.scheduledRehearsal = true;
    s.scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.rehearsal.run).toHaveBeenCalledTimes(1);
    s.profile.verification.scheduledRehearsal = false;
    s.scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(3 * DEEP_CHECK_MS);
    expect(s.rehearsal.run).toHaveBeenCalledTimes(1);
  });
});
