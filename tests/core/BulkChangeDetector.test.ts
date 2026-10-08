import { describe, expect, it } from "vitest";
import { BulkChangeDetector } from "../../src/core/BulkChangeDetector";
import { MockClock } from "../mocks/MockClock";

const limits = { count: 3, windowSec: 10, cooldownSec: 60 };

describe("BulkChangeDetector", () => {
  it("fires when the count of different files is reached inside the window", () => {
    const clock = new MockClock(0);
    const d = new BulkChangeDetector(clock, limits);
    expect([d.record("a"), d.record("b"), d.record("c")]).toEqual([false, false, true]);
  });

  it("counts a file once", () => {
    const d = new BulkChangeDetector(new MockClock(0), limits);
    expect([d.record("a"), d.record("a"), d.record("a"), d.record("a")]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("forgets files outside the window", () => {
    const clock = new MockClock(0);
    const d = new BulkChangeDetector(clock, limits);
    d.record("a");
    d.record("b");
    clock.advance(11_000);
    expect(d.record("c")).toBe(false);
  });

  it("fires once per operation, then again after the cooldown", () => {
    const clock = new MockClock(0);
    const d = new BulkChangeDetector(clock, limits);
    ["a", "b", "c"].forEach((p) => d.record(p));
    expect(["d", "e", "f", "g"].map((p) => d.record(p))).toEqual([false, false, false, false]);
    clock.advance(61_000);
    expect(["h", "i", "j"].map((p) => d.record(p))).toEqual([false, false, true]);
  });
});
