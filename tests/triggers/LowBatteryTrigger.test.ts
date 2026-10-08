import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import { evaluateConditions } from "../../src/triggers/Conditions";
import {
  BATTERY_POLL_MS,
  LowBatteryTrigger,
  REARM_MARGIN_PCT,
} from "../../src/triggers/LowBatteryTrigger";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";
import { MockPlatform } from "../mocks/MockPlatform";
import { MockVaultStore } from "../mocks/MockVaultStore";

function setup(pct = 10) {
  const profile = createDefaultProfile("mobile");
  profile.conditions.lowBatteryFlush = true;
  profile.conditions.lowBatteryFlushPct = pct;
  const platform = new MockPlatform("mobile");
  const fired: TriggerReason[] = [];
  const logger = new MockLogger();
  const trigger = new LowBatteryTrigger(
    {
      clock: { now: () => Date.now() },
      logger,
      getProfile: () => profile,
      run: async (reason) => {
        fired.push(reason);
      },
    },
    globalTimerHost,
    platform,
  );
  const battery = (level: number, charging = false) => {
    platform.battery = { level, charging };
  };
  const tick = () => vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
  return { trigger, profile, platform, fired, logger, battery, tick };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LowBatteryTrigger", () => {
  it("flushes once when the level reaches the threshold on battery power", async () => {
    const t = setup(10);
    t.trigger.start();
    t.battery(50);
    await t.tick();
    t.battery(11);
    await t.tick();
    expect(t.fired).toEqual([]);
    t.battery(10);
    await t.tick();
    expect(t.fired).toEqual(["low-battery"]);
    t.battery(8);
    await t.tick();
    await t.tick();
    expect(t.fired).toEqual(["low-battery"]); // once per discharge
  });

  it("does nothing while charging", async () => {
    const t = setup();
    t.trigger.start();
    t.battery(3, true);
    await t.tick();
    expect(t.fired).toEqual([]);
  });

  it("re-arms after charging or after climbing well above the threshold", async () => {
    const t = setup(10);
    t.trigger.start();
    t.battery(9);
    await t.tick();
    expect(t.fired).toHaveLength(1);
    t.battery(9, true);
    await t.tick();
    t.battery(9);
    await t.tick();
    expect(t.fired).toHaveLength(2);
    t.battery(10 + REARM_MARGIN_PCT + 1);
    await t.tick();
    t.battery(10);
    await t.tick();
    expect(t.fired).toHaveLength(3);
  });

  it("does not re-arm for a small rise just above the threshold", async () => {
    const t = setup(10);
    t.trigger.start();
    t.battery(9);
    await t.tick();
    t.battery(12);
    await t.tick();
    t.battery(9);
    await t.tick();
    expect(t.fired).toHaveLength(1);
  });

  it("checks when the app goes to the background", async () => {
    const t = setup(10);
    t.trigger.start();
    t.battery(8);
    t.platform.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fired).toEqual([]);
    t.platform.setVisible(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fired).toEqual(["low-battery"]);
  });

  it("does nothing when the platform gives no battery information, or the setting is off", async () => {
    const t = setup();
    t.trigger.start();
    t.platform.battery = null;
    await t.tick();
    expect(t.fired).toEqual([]);
    t.battery(2);
    t.profile.conditions.lowBatteryFlush = false;
    await t.tick();
    expect(t.fired).toEqual([]);
    t.profile.conditions.lowBatteryFlush = true;
    await t.tick();
    expect(t.fired).toEqual(["low-battery"]);
  });

  it("stops polling and listening on stop", async () => {
    const t = setup();
    t.trigger.start();
    expect(t.trigger.isActive).toBe(true);
    t.trigger.stop();
    expect(t.trigger.isActive).toBe(false);
    expect(t.platform.listenerCount).toBe(0);
    t.battery(1);
    await t.tick();
    expect(t.fired).toEqual([]);
  });
});

describe("the minimum-battery condition and the flush", () => {
  it("blocks a normal automatic run at low battery but not when ignoreBattery is set", async () => {
    const profile = createDefaultProfile("mobile");
    profile.conditions.minBatteryPct = 20;
    profile.conditions.skipIfNoChanges = false;
    profile.conditions.minFreeSpaceMb = 0;
    const platform = new MockPlatform("mobile");
    platform.battery = { level: 8, charging: false };
    const base = {
      store: new MockVaultStore(),
      logger: new MockLogger(),
      platform,
      getProfile: () => profile,
    };
    expect((await evaluateConditions(base)).ok).toBe(false);
    expect((await evaluateConditions({ ...base, ignoreBattery: true })).ok).toBe(true);
  });
});
