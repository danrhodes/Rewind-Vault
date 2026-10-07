import { describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import { ResumeTrigger } from "../../src/triggers/ResumeTrigger";
import type { TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockClock } from "../mocks/MockClock";
import { MockLogger } from "../mocks/MockLogger";
import { MockPlatform } from "../mocks/MockPlatform";

const MIN = 60_000;

function setup(
  tweak: (p: ReturnType<typeof createDefaultProfile>) => void = () => undefined,
  options: ConstructorParameters<typeof ResumeTrigger>[2] = {},
) {
  const profile = createDefaultProfile("mobile");
  profile.triggers.onResume = true;
  profile.triggers.resumeMinGapMin = 30;
  tweak(profile);
  const clock = new MockClock();
  const logger = new MockLogger();
  const platform = new MockPlatform("mobile");
  const fired: TriggerReason[] = [];
  const run = vi.fn<(r: TriggerReason) => Promise<void>>(async (r) => {
    fired.push(r);
  });
  const trigger = new ResumeTrigger(
    { clock, logger, getProfile: () => profile, run },
    platform,
    options,
  );
  /** Go to the background, wait `awayMs`, come back, and let async work settle. */
  const background = async (awayMs: number): Promise<void> => {
    platform.setVisible(false);
    clock.advance(awayMs);
    platform.setVisible(true);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { trigger, platform, clock, logger, profile, fired, run, background };
}

describe("ResumeTrigger", () => {
  it("fires when the app returns to the foreground after being hidden", async () => {
    const s = setup();
    s.trigger.start();
    await s.background(5 * 60 * MIN);
    expect(s.fired).toEqual(["resume"]);
  });

  it("does not fire for visibility events that did not start hidden, nor when going hidden", async () => {
    const s = setup();
    s.trigger.start();
    s.platform.setVisible(true); // already visible
    s.platform.setVisible(true);
    s.platform.setVisible(false); // going to background
    await Promise.resolve();
    expect(s.fired).toEqual([]);
  });

  it("starting while hidden counts the first return as a resume", async () => {
    const s = setup();
    s.platform.visible = false;
    s.trigger.start();
    s.platform.setVisible(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.fired).toEqual(["resume"]);
  });

  it("respects the minimum gap, then fires once it has passed", async () => {
    const s = setup();
    s.trigger.start();
    await s.background(60 * MIN);
    expect(s.fired).toHaveLength(1);
    await s.background(10 * MIN); // only 10 min since the last one
    expect(s.fired).toHaveLength(1);
    await s.background(10 * MIN); // 20 min
    expect(s.fired).toHaveLength(1);
    await s.background(10 * MIN); // 30 min: allowed
    expect(s.fired).toHaveLength(2);
  });

  it("a zero gap allows every resume", async () => {
    const s = setup((p) => void (p.triggers.resumeMinGapMin = 0));
    s.trigger.start();
    await s.background(1000);
    await s.background(1000);
    await s.background(1000);
    expect(s.fired).toHaveLength(3);
  });

  it("the gap also counts a backup made by another trigger", async () => {
    let lastBackup: number | null = null;
    const s = setup(undefined, { lastBackupAt: async () => lastBackup });
    s.trigger.start();
    lastBackup = s.clock.now() + 5 * MIN; // a scheduled backup ran while we were away
    await s.background(10 * MIN);
    expect(s.fired).toEqual([]); // 5 minutes since that backup
    await s.background(40 * MIN);
    expect(s.fired).toHaveLength(1);
  });

  it("an unreadable last-backup time falls back to the trigger's own record", async () => {
    const s = setup(undefined, {
      lastBackupAt: async () => {
        throw new Error("index unreadable");
      },
    });
    s.trigger.start();
    await s.background(60 * MIN);
    expect(s.fired).toHaveLength(1);
    await s.background(5 * MIN);
    expect(s.fired).toHaveLength(1);
  });

  it("does nothing when the option is off, and picks up the setting live", async () => {
    const s = setup((p) => void (p.triggers.onResume = false));
    s.trigger.start();
    await s.background(120 * MIN);
    expect(s.fired).toEqual([]);
    s.profile.triggers.onResume = true;
    await s.background(120 * MIN);
    expect(s.fired).toHaveLength(1);
  });

  it("never starts a second run while one is still going", async () => {
    let release: () => void = () => undefined;
    const s = setup((p) => void (p.triggers.resumeMinGapMin = 0));
    s.run.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    s.trigger.start();
    await s.background(1000);
    await s.background(1000);
    expect(s.run).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await s.background(1000);
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("a failing run is logged and later resumes still work", async () => {
    const s = setup((p) => void (p.triggers.resumeMinGapMin = 0));
    s.run.mockRejectedValueOnce(new Error("locked"));
    s.trigger.start();
    await s.background(1000);
    await Promise.resolve();
    expect(s.logger.entries.some((e) => e.level === "error" && /locked/.test(e.message))).toBe(
      true,
    );
    await s.background(1000);
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("stop() unsubscribes; start() twice does not double-subscribe", async () => {
    const s = setup();
    s.trigger.start();
    s.trigger.start();
    expect(s.platform.listenerCount).toBe(1);
    expect(s.trigger.isActive).toBe(true);
    s.trigger.stop();
    expect(s.platform.listenerCount).toBe(0);
    expect(s.trigger.isActive).toBe(false);
    await s.background(120 * MIN);
    expect(s.fired).toEqual([]);
  });
});
