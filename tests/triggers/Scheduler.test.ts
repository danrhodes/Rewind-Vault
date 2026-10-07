import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import { Scheduler, parseDailyTimes } from "../../src/triggers/Scheduler";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 01:00 local on 7 Oct 2026 (local time so the daily-time tests hold in any time zone). */
const T0 = new Date(2026, 9, 7, 1, 0, 0).getTime();

interface Setup {
  scheduler: Scheduler;
  fired: TriggerReason[];
  logger: MockLogger;
  profile: ReturnType<typeof createDefaultProfile>;
  run: ReturnType<typeof vi.fn>;
}

function setup(
  tweak: (t: ReturnType<typeof createDefaultProfile>["triggers"]) => void,
  runImpl?: () => Promise<void>,
): Setup {
  const profile = createDefaultProfile("desktop");
  // Start from everything off (the desktop defaults enable the interval trigger).
  profile.triggers.intervalEnabled = false;
  profile.triggers.dailyTimes = [];
  tweak(profile.triggers);
  const logger = new MockLogger();
  const fired: TriggerReason[] = [];
  const run = vi.fn(async (reason: TriggerReason) => {
    fired.push(reason);
    await runImpl?.();
  });
  const scheduler = new Scheduler(
    { clock: { now: () => Date.now() }, logger, getProfile: () => profile, run },
    globalTimerHost,
  );
  return { scheduler, fired, logger, profile, run };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parseDailyTimes", () => {
  it("accepts HH:MM, trims, drops invalid and duplicates", () => {
    expect(
      parseDailyTimes(["02:00", " 03:15 ", "24:00", "9:30", "ab", "12:60", "02:00", "23:59", ""]),
    ).toEqual([
      { hour: 2, minute: 0 },
      { hour: 3, minute: 15 },
      { hour: 23, minute: 59 },
    ]);
  });
});

describe("interval trigger", () => {
  it("does nothing when disabled", async () => {
    const s = setup(() => undefined);
    s.scheduler.start();
    expect(s.scheduler.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(s.fired).toEqual([]);
  });

  it("fires every N minutes with reason interval, and stops on stop()", async () => {
    const s = setup((t) => {
      t.intervalEnabled = true;
      t.intervalMinutes = 5;
    });
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(4 * MIN + 59_000);
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.fired).toEqual(["interval"]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.fired).toHaveLength(3);
    s.scheduler.stop();
    expect(s.scheduler.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(s.fired).toHaveLength(3);
  });

  it("reconfigure applies changed settings and does not leave the old timer running", async () => {
    const s = setup((t) => {
      t.intervalEnabled = true;
      t.intervalMinutes = 10;
    });
    s.scheduler.start();
    s.profile.triggers.intervalMinutes = 30;
    s.scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.fired).toHaveLength(1);
    s.profile.triggers.intervalEnabled = false;
    s.scheduler.reconfigure();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(s.fired).toHaveLength(1);
  });

  it("clamps a nonsense interval to one minute", async () => {
    const s = setup((t) => {
      t.intervalEnabled = true;
      t.intervalMinutes = 0;
    });
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.fired).toHaveLength(1);
  });

  it("restarting does not stack timers", async () => {
    const s = setup((t) => {
      t.intervalEnabled = true;
      t.intervalMinutes = 5;
    });
    s.scheduler.start();
    s.scheduler.start();
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.fired).toHaveLength(1);
  });
});

describe("daily times", () => {
  it("fires once at the time, again the next day, never twice in a day", async () => {
    const s = setup((t) => void (t.dailyTimes = ["02:00"]));
    s.scheduler.start(); // 01:00
    await vi.advanceTimersByTimeAsync(59 * MIN + 40_000); // 01:59:40
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(40_000); // 02:00:20
    expect(s.fired).toEqual(["daily"]);
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(s.fired).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15 * HOUR); // 03:00 next day
    expect(s.fired).toHaveLength(2);
  });

  it("supports several times a day", async () => {
    const s = setup((t) => void (t.dailyTimes = ["02:00", "14:30", "23:00"]));
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(23 * HOUR); // to 00:00 next day
    expect(s.fired).toHaveLength(3);
  });

  it("a time that already passed today waits for tomorrow", async () => {
    const s = setup((t) => void (t.dailyTimes = ["00:30"]));
    s.scheduler.start(); // 01:00, 00:30 already gone
    await vi.advanceTimersByTimeAsync(22 * HOUR);
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * HOUR); // past 00:30 next day
    expect(s.fired).toHaveLength(1);
  });

  it("catches up once after the machine slept through the time", async () => {
    const s = setup((t) => void (t.dailyTimes = ["02:00"]));
    s.scheduler.start();
    vi.setSystemTime(T0 + 5 * HOUR); // laptop was asleep until 06:00
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.fired).toEqual(["daily"]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(s.fired).toHaveLength(1);
  });

  it("several times missed while asleep still make just one backup", async () => {
    const s = setup((t) => void (t.dailyTimes = ["02:00", "03:00", "04:00"]));
    s.scheduler.start();
    vi.setSystemTime(T0 + 6 * HOUR);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.fired).toHaveLength(1);
  });

  it("a clock set backwards fires nothing", async () => {
    const s = setup((t) => void (t.dailyTimes = ["02:00"]));
    s.scheduler.start();
    vi.setSystemTime(T0 - 3 * HOUR);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.fired).toEqual([]);
  });

  it("invalid entries are ignored with a warning; valid ones still work", async () => {
    const s = setup((t) => void (t.dailyTimes = ["nope", "01:30"]));
    s.scheduler.start();
    expect(s.logger.entries.some((e) => e.level === "warn")).toBe(true);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(s.fired).toHaveLength(1);
  });

  it("interval and daily can run together with their own reasons", async () => {
    const s = setup((t) => {
      t.intervalEnabled = true;
      t.intervalMinutes = 45;
      t.dailyTimes = ["01:30"];
    });
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect([...s.fired].sort()).toEqual(["daily", "interval"]);
  });
});

describe("run handling", () => {
  it("never overlaps its own runs: a tick during a running backup is skipped", async () => {
    let release: () => void = () => undefined;
    const s = setup(
      (t) => {
        t.intervalEnabled = true;
        t.intervalMinutes = 1;
      },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(s.run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("a failing run is logged and the schedule carries on", async () => {
    let calls = 0;
    const s = setup(
      (t) => {
        t.intervalEnabled = true;
        t.intervalMinutes = 1;
      },
      async () => {
        if (++calls === 1) throw new Error("disk full");
      },
    );
    s.scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(s.logger.entries.some((e) => e.level === "error" && /disk full/.test(e.message))).toBe(
      true,
    );
    expect(s.run.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
