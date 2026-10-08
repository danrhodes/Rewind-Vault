import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { VaultEventKind } from "../../src/triggers/EventTrigger";
import { TriggerManager } from "../../src/triggers/TriggerManager";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";
import { MockPlatform } from "../mocks/MockPlatform";

const MIN = 60_000;

function setup(tweak: (p: ReturnType<typeof createDefaultProfile>) => void = () => undefined) {
  const profile = createDefaultProfile("desktop");
  profile.basic.backupOnStartup = true;
  profile.triggers.onStartup = true;
  profile.basic.startupDelaySec = 0;
  profile.triggers.intervalEnabled = true;
  profile.triggers.intervalMinutes = 10;
  profile.triggers.dailyTimes = [];
  tweak(profile);
  const fired: TriggerReason[] = [];
  const platform = new MockPlatform("desktop");
  const listeners = new Map<VaultEventKind, Set<(p: string) => void>>();
  const closeListeners = new Set<() => void>();
  let ready: (() => void) | null = null;
  const manager = new TriggerManager({
    triggers: {
      clock: { now: () => Date.now() },
      logger: new MockLogger(),
      getProfile: () => profile,
      run: async (reason) => {
        fired.push(reason);
      },
    },
    platform,
    timers: globalTimerHost,
    events: {
      on(kind, cb) {
        const set = listeners.get(kind) ?? new Set();
        set.add(cb);
        listeners.set(kind, set);
        return () => set.delete(cb);
      },
    },
    close: {
      onBeforeClose(cb) {
        closeListeners.add(cb);
        return () => closeListeners.delete(cb);
      },
    },
    whenReady: (cb) => {
      ready = cb;
    },
    lastBackupAt: async () => null,
  });
  const listenerTotal = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return {
    manager,
    profile,
    fired,
    platform,
    closeListeners,
    listenerTotal,
    ready: () => (ready as (() => void) | null)?.(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TriggerManager", () => {
  it("starts every trigger on load", async () => {
    const t = setup((p) => (p.triggers.onClose = true));
    t.manager.start();
    expect(t.manager.isStarted).toBe(true);
    expect(t.platform.listenerCount).toBe(2); // resume + low battery
    expect(t.listenerTotal()).toBe(6); // 4 edit events + delete/rename for pre-risk
    expect(t.closeListeners.size).toBe(1);
    t.ready();
    expect(t.fired).toEqual(["startup"]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(t.fired).toEqual(["startup", "interval"]);
  });

  it("stops every trigger on unload", async () => {
    const t = setup();
    t.manager.start();
    t.manager.stop();
    expect(t.manager.isStarted).toBe(false);
    expect(t.platform.listenerCount).toBe(0);
    expect(t.listenerTotal()).toBe(0);
    expect(t.closeListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(t.fired).toEqual([]);
    t.ready(); // the app became ready after unload: nothing fires
    expect(t.fired).toEqual([]);
  });

  it("restarts the interval when settings change, without re-firing startup", async () => {
    const t = setup();
    t.manager.start();
    t.ready();
    expect(t.fired).toEqual(["startup"]);
    t.profile.triggers.intervalMinutes = 5;
    t.manager.reconfigure();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(t.fired).toEqual(["startup", "interval"]);
    t.profile.triggers.intervalEnabled = false;
    t.manager.reconfigure();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(t.fired).toEqual(["startup", "interval"]);
  });

  it("ignores reconfigure before start", async () => {
    const t = setup();
    t.manager.reconfigure();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(t.fired).toEqual([]);
  });
});
