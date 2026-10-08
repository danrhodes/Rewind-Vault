import { describe, expect, it } from "vitest";
import { MassChangeGuard, type MassChangeLimits } from "../../src/core/MassChangeGuard";
import { MockClock } from "../mocks/MockClock";

function setup(limits: Partial<MassChangeLimits> = {}) {
  const clock = new MockClock(1_000_000);
  const current: MassChangeLimits = { enabled: true, threshold: 5, windowSec: 60, ...limits };
  const guard = new MassChangeGuard(clock, () => current);
  const touch = (n: number, prefix = "f", stepMs = 0): boolean[] =>
    Array.from({ length: n }, (_, i) => {
      if (stepMs) clock.advance(stepMs);
      return guard.record(`${prefix}${i}.md`);
    });
  return { guard, clock, current, touch };
}

describe("MassChangeGuard", () => {
  it("does not trip at the threshold, only above it", () => {
    const t = setup();
    expect(t.touch(5)).toEqual([false, false, false, false, false]);
    expect(t.guard.isTripped).toBe(false);
    expect(t.guard.record("one-more.md")).toBe(true);
    expect(t.guard.isTripped).toBe(true);
    expect(t.guard.tripInfo).toMatchObject({ files: 6, windowSec: 60, trippedAt: 1_000_000 });
  });

  it("counts each file once per window, so an autosaving note never trips it", () => {
    const t = setup();
    for (let i = 0; i < 500; i++) t.guard.record("same.md");
    expect(t.guard.isTripped).toBe(false);
  });

  it("forgets changes older than the window", () => {
    const t = setup();
    t.touch(5, "old");
    t.clock.advance(61_000);
    t.touch(5, "new");
    expect(t.guard.isTripped).toBe(false);
  });

  it("trips on a steady stream that stays inside the window", () => {
    const t = setup();
    const results = t.touch(6, "s", 5_000); // 30 s in total
    expect(results[results.length - 1]).toBe(true);
  });

  it("reports the trip once and stays tripped until released", () => {
    const t = setup();
    t.touch(5);
    expect(t.guard.record("x.md")).toBe(true);
    expect(t.guard.record("y.md")).toBe(false);
    t.clock.advance(10 * 60_000);
    expect(t.guard.isTripped).toBe(true);
    t.guard.release();
    expect(t.guard.isTripped).toBe(false);
    expect(t.guard.tripInfo).toBeNull();
    expect(t.touch(5, "again")).toEqual([false, false, false, false, false]);
  });

  it("does nothing while disabled, and disabling clears a trip", () => {
    const t = setup();
    t.touch(6);
    expect(t.guard.isTripped).toBe(true);
    t.current.enabled = false;
    expect(t.guard.isTripped).toBe(false);
    expect(t.touch(50, "off").some(Boolean)).toBe(false);
    t.current.enabled = true;
    expect(t.guard.isTripped).toBe(false);
  });

  it("reads the limits live", () => {
    const t = setup({ threshold: 100 });
    t.touch(10);
    t.current.threshold = 5;
    expect(t.guard.record("last.md")).toBe(true);
  });
});
