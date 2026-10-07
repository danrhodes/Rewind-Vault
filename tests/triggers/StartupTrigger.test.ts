import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import { StartupTrigger, startupEnabled } from "../../src/triggers/StartupTrigger";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(tweak: (p: ReturnType<typeof createDefaultProfile>) => void = () => undefined) {
  const profile = createDefaultProfile("desktop");
  tweak(profile);
  const logger = new MockLogger();
  const fired: TriggerReason[] = [];
  const run = vi.fn(async (r: TriggerReason) => void fired.push(r));
  const trigger = new StartupTrigger(
    { clock: { now: () => Date.now() }, logger, getProfile: () => profile, run },
    globalTimerHost,
  );
  /** Obsidian's onLayoutReady: collects callbacks until `layoutReady()` is called. */
  const waiting: (() => void)[] = [];
  const whenReady = (cb: () => void): void => void waiting.push(cb);
  const layoutReady = (): void => waiting.splice(0).forEach((cb) => cb());
  return { trigger, profile, logger, fired, run, whenReady, layoutReady };
}

describe("startupEnabled", () => {
  it("needs both the Basic and the Triggers switch", () => {
    const flags = (basic: boolean, trig: boolean) => {
      const s = setup((p) => {
        p.basic.backupOnStartup = basic;
        p.triggers.onStartup = trig;
      });
      return startupEnabled({ getProfile: () => s.profile });
    };
    expect([
      flags(true, true),
      flags(true, false),
      flags(false, true),
      flags(false, false),
    ]).toEqual([true, false, false, false]);
  });
});

describe("StartupTrigger", () => {
  it("does nothing until the layout is ready, then waits the delay, then fires once", async () => {
    const s = setup((p) => void (p.basic.startupDelaySec = 15));
    s.trigger.start(s.whenReady);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.fired).toEqual([]); // layout not ready: not even the timer has started
    s.layoutReady();
    expect(s.trigger.isPending).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fired).toEqual(["startup"]);
    expect(s.trigger.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.fired).toHaveLength(1);
  });

  it("a zero delay fires immediately on layout ready", async () => {
    const s = setup((p) => void (p.basic.startupDelaySec = 0));
    s.trigger.start(s.whenReady);
    s.layoutReady();
    expect(s.fired).toEqual(["startup"]);
  });

  it("works when the host calls back synchronously (layout already ready)", () => {
    const s = setup((p) => void (p.basic.startupDelaySec = 0));
    s.trigger.start((cb) => cb());
    expect(s.fired).toEqual(["startup"]);
  });

  it("clamps the delay to 0-300 s and tolerates nonsense", async () => {
    const big = setup((p) => void (p.basic.startupDelaySec = 99999));
    big.trigger.start(big.whenReady);
    big.layoutReady();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(big.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(big.fired).toHaveLength(1);

    for (const bad of [-5, Number.NaN]) {
      const s = setup((p) => void (p.basic.startupDelaySec = bad));
      s.trigger.start(s.whenReady);
      s.layoutReady();
      expect(s.fired).toHaveLength(1);
    }
  });

  it.each([
    [
      "Basic switch off",
      (p: ReturnType<typeof createDefaultProfile>) => void (p.basic.backupOnStartup = false),
    ],
    [
      "Triggers switch off",
      (p: ReturnType<typeof createDefaultProfile>) => void (p.triggers.onStartup = false),
    ],
  ])("never fires with %s", async (_n, tweak) => {
    const s = setup(tweak);
    s.trigger.start(s.whenReady);
    s.layoutReady();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.fired).toEqual([]);
    expect(s.trigger.isPending).toBe(false);
  });

  it("turning the option off during the delay cancels the backup", async () => {
    const s = setup((p) => void (p.basic.startupDelaySec = 30));
    s.trigger.start(s.whenReady);
    s.layoutReady();
    await vi.advanceTimersByTimeAsync(10_000);
    s.profile.basic.backupOnStartup = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.fired).toEqual([]);
  });

  it("stop() during the delay cancels it; stop() before ready ignores the later ready", async () => {
    const a = setup((p) => void (p.basic.startupDelaySec = 30));
    a.trigger.start(a.whenReady);
    a.layoutReady();
    a.trigger.stop();
    expect(a.trigger.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.fired).toEqual([]);

    const b = setup((p) => void (p.basic.startupDelaySec = 0));
    b.trigger.start(b.whenReady);
    b.trigger.stop();
    b.layoutReady();
    expect(b.fired).toEqual([]);
  });

  it("restarting replaces a pending run rather than doubling it", async () => {
    const s = setup((p) => void (p.basic.startupDelaySec = 20));
    s.trigger.start(s.whenReady);
    s.layoutReady();
    await vi.advanceTimersByTimeAsync(10_000);
    s.trigger.start(s.whenReady);
    s.layoutReady();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.fired).toHaveLength(1);
  });

  it("a failing run is logged, not thrown", async () => {
    const s = setup((p) => void (p.basic.startupDelaySec = 0));
    s.run.mockRejectedValueOnce(new Error("locked"));
    s.trigger.start(s.whenReady);
    s.layoutReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.logger.entries.some((e) => e.level === "error" && /locked/.test(e.message))).toBe(
      true,
    );
  });
});
