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

function setup(options: { enabled: boolean; due?: () => boolean; run?: () => Promise<void> }) {
  const profile = createDefaultProfile("desktop");
  profile.triggers.intervalEnabled = false;
  profile.verification.scheduledDeepVerify = options.enabled;
  const logger = new MockLogger();
  const backups = vi.fn(async () => undefined);
  const job: DeepVerifyJob = {
    isDue: vi.fn(async () => options.due?.() ?? true),
    run: vi.fn(options.run ?? (async () => undefined)),
  };
  const scheduler = new Scheduler(
    { clock: { now: () => Date.now() }, logger, getProfile: () => profile, run: backups },
    globalTimerHost,
    job,
  );
  return { scheduler, job, logger, profile, backups };
}

describe("scheduled deep verify in the scheduler", () => {
  it("does nothing when the setting is off, and starts no timer", async () => {
    const s = setup({ enabled: false });
    s.scheduler.start();
    expect(s.scheduler.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * DEEP_CHECK_MS);
    expect(s.job.isDue).not.toHaveBeenCalled();
  });

  it("asks whether a run is due on every check and runs it only when due", async () => {
    let due = false;
    const s = setup({ enabled: true, due: () => due });
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.job.isDue).toHaveBeenCalledTimes(1);
    expect(s.job.run).not.toHaveBeenCalled();
    due = true;
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.job.run).toHaveBeenCalledTimes(1);
  });

  it("reconfigure follows the setting both ways", async () => {
    const s = setup({ enabled: false });
    s.scheduler.start();
    s.profile.verification.scheduledDeepVerify = true;
    s.scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.job.run).toHaveBeenCalledTimes(1);
    s.profile.verification.scheduledDeepVerify = false;
    s.scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(3 * DEEP_CHECK_MS);
    expect(s.job.run).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a running deep verify, and stop() ends the checks", async () => {
    let release: () => void = () => undefined;
    const s = setup({ enabled: true, run: () => new Promise<void>((r) => (release = r)) });
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * DEEP_CHECK_MS);
    expect(s.job.run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(s.job.run).toHaveBeenCalledTimes(2);
    s.scheduler.stop();
    await vi.advanceTimersByTimeAsync(5 * DEEP_CHECK_MS);
    expect(s.job.run).toHaveBeenCalledTimes(2);
  });

  it("a failing job is logged and checking continues", async () => {
    let calls = 0;
    const s = setup({
      enabled: true,
      run: async () => {
        if (++calls === 1) throw new Error("boom");
      },
    });
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * DEEP_CHECK_MS);
    expect(s.logger.entries.some((e) => e.level === "error" && /boom/.test(e.message))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("shares the busy guard with backups: no deep verify while a scheduled backup runs", async () => {
    let release: () => void = () => undefined;
    const profile = createDefaultProfile("desktop");
    profile.triggers.intervalEnabled = true;
    profile.triggers.intervalMinutes = 1;
    profile.verification.scheduledDeepVerify = true;
    const job: DeepVerifyJob = {
      isDue: vi.fn(async () => true),
      run: vi.fn(async () => undefined),
    };
    const scheduler = new Scheduler(
      {
        clock: { now: () => Date.now() },
        logger: new MockLogger(),
        getProfile: () => profile,
        run: () => new Promise<void>((r) => (release = r)),
      },
      globalTimerHost,
      job,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS + 1000); // backup started at 1 min, never ends
    expect(job.run).not.toHaveBeenCalled();
    profile.triggers.intervalEnabled = false; // otherwise the next minute starts another backup
    release();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(DEEP_CHECK_MS);
    expect(job.run).toHaveBeenCalled();
  });
});
