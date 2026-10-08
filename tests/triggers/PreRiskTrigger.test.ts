import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRE_RISK } from "../../src/constants";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { VaultEventKind } from "../../src/triggers/EventTrigger";
import { PreRiskTrigger } from "../../src/triggers/PreRiskTrigger";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";

function setup(
  plugins: {
    check: () => Promise<{ id: string; from: string | null; to: string }[]>;
  } | null = null,
) {
  const profile = createDefaultProfile("desktop");
  profile.safety.preRiskSnapshots = true;
  const fired: TriggerReason[] = [];
  const handlers = new Map<VaultEventKind, Set<(p: string) => void>>();
  let ready: (() => void) | null = null;
  const trigger = new PreRiskTrigger(
    {
      clock: { now: () => Date.now() },
      logger: new MockLogger(),
      getProfile: () => profile,
      run: async (reason) => {
        fired.push(reason);
      },
    },
    globalTimerHost,
    {
      on(kind, cb) {
        const set = handlers.get(kind) ?? new Set();
        set.add(cb);
        handlers.set(kind, set);
        return () => set.delete(cb);
      },
    },
    plugins,
  );
  const emit = (kind: VaultEventKind, path: string) =>
    handlers.get(kind)?.forEach((cb) => cb(path));
  const count = () => [...handlers.values()].reduce((n, s) => n + s.size, 0);
  return {
    trigger,
    profile,
    fired,
    emit,
    count,
    ready: () => (ready as (() => void) | null)?.(),
    setReady: (cb: () => void) => (ready = cb),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const burst = (t: ReturnType<typeof setup>, kind: VaultEventKind, n: number, prefix = "n") => {
  for (let i = 0; i < n; i++) t.emit(kind, `${prefix}${i}.md`);
};

describe("PreRiskTrigger: bulk delete / rename", () => {
  it("requests one pre-risk snapshot for a bulk delete", () => {
    const t = setup();
    t.trigger.start(t.setReady);
    burst(t, "delete", PRE_RISK.bulkCount - 1);
    expect(t.fired).toEqual([]);
    t.emit("delete", "last.md");
    expect(t.fired).toEqual(["pre-risk"]);
    burst(t, "delete", 50, "more"); // same operation: quiet
    expect(t.fired).toEqual(["pre-risk"]);
  });

  it("counts renames together with deletes", () => {
    const t = setup();
    t.trigger.start(t.setReady);
    burst(t, "rename", 5);
    burst(t, "delete", 5, "d");
    expect(t.fired).toEqual(["pre-risk"]);
  });

  it("ignores edits and creations", () => {
    const t = setup();
    t.trigger.start(t.setReady);
    burst(t, "modify", 50);
    burst(t, "create", 50, "c");
    expect(t.fired).toEqual([]);
  });

  it("ignores deletions inside the backup and restore folders", () => {
    const t = setup();
    t.trigger.start(t.setReady);
    burst(t, "delete", 30, `${t.profile.destination.backupFolder}/old/part-`);
    burst(t, "delete", 30, `${t.profile.destination.restoreFolder}/x/`);
    expect(t.fired).toEqual([]);
  });

  it("does nothing when the setting is off", () => {
    const t = setup();
    t.profile.safety.preRiskSnapshots = false;
    t.trigger.start(t.setReady);
    burst(t, "delete", 50);
    expect(t.fired).toEqual([]);
  });

  it("stops listening on stop", () => {
    const t = setup();
    t.trigger.start(t.setReady);
    expect(t.trigger.isActive).toBe(true);
    t.trigger.stop();
    expect(t.count()).toBe(0);
    burst(t, "delete", 50);
    expect(t.fired).toEqual([]);
  });
});

describe("PreRiskTrigger: plugin changes", () => {
  it("snapshots when the app is ready and a plugin changed", async () => {
    const check = vi.fn(async () => [{ id: "a", from: "1", to: "2" }]);
    const t = setup({ check });
    t.trigger.start(t.setReady);
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fired).toEqual(["pre-risk"]);
  });

  it("checks again on a timer and snapshots only on changes", async () => {
    const results = [[], [], [{ id: "a", from: "1", to: "2" }]];
    const check = vi.fn(async () => results.shift() ?? []);
    const t = setup({ check });
    t.trigger.start(t.setReady);
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(PRE_RISK.pluginCheckMin * 60_000);
    expect(t.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(PRE_RISK.pluginCheckMin * 60_000);
    expect(t.fired).toEqual(["pre-risk"]);
  });

  it("keeps recording but does not snapshot when the setting is off", async () => {
    const check = vi.fn(async () => [{ id: "a", from: "1", to: "2" }]);
    const t = setup({ check });
    t.profile.safety.preRiskSnapshots = false;
    t.trigger.start(t.setReady);
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalled();
    expect(t.fired).toEqual([]);
  });

  it("survives a failing check and stops its timer", async () => {
    const check = vi.fn(async () => {
      throw new Error("unreadable");
    });
    const t = setup({ check });
    t.trigger.start(t.setReady);
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fired).toEqual([]);
    t.trigger.stop();
    check.mockClear();
    await vi.advanceTimersByTimeAsync(PRE_RISK.pluginCheckMin * 60_000 * 3);
    expect(check).not.toHaveBeenCalled();
  });

  it("does not start the timer if stopped before the app was ready", async () => {
    const check = vi.fn(async () => []);
    const t = setup({ check });
    t.trigger.start(t.setReady);
    t.trigger.stop();
    t.ready();
    await vi.advanceTimersByTimeAsync(PRE_RISK.pluginCheckMin * 60_000 * 2);
    expect(check).not.toHaveBeenCalled();
  });
});
