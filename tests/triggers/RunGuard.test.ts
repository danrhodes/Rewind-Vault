import { describe, expect, it } from "vitest";
import { LockError } from "../../src/helpers/errors";
import { DEFAULT_COOLDOWN_MS, RunGuard } from "../../src/triggers/RunGuard";
import type { TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockClock } from "../mocks/MockClock";
import { MockLogger } from "../mocks/MockLogger";

function setup(options: { cooldownMs?: number; run?: (r: TriggerReason) => Promise<void> } = {}) {
  const clock = new MockClock(1_000_000);
  const logger = new MockLogger();
  const calls: TriggerReason[] = [];
  const guard = new RunGuard({
    clock,
    logger,
    cooldownMs: options.cooldownMs,
    run: async (reason) => {
      calls.push(reason);
      await options.run?.(reason);
    },
  });
  return { guard, clock, logger, calls };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

describe("RunGuard", () => {
  it("passes a request through and reports running only while it runs", async () => {
    const gate = deferred();
    const { guard, calls } = setup({ run: () => gate.promise });
    const pending = guard.request("startup");
    expect(guard.isRunning).toBe(true);
    gate.release();
    await pending;
    expect(guard.isRunning).toBe(false);
    expect(calls).toEqual(["startup"]);
  });

  it("drops a request while a run is in progress (no overlap) and logs why", async () => {
    const gate = deferred();
    const { guard, calls, logger } = setup({ run: () => gate.promise });
    const first = guard.request("interval");
    await guard.request("resume");
    await guard.request("edits");
    gate.release();
    await first;
    expect(calls).toEqual(["interval"]);
    expect(logger.messages("debug").filter((m) => m.includes("already running"))).toHaveLength(2);
  });

  it("drops requests inside the cooldown and allows them after it", async () => {
    const { guard, clock, calls } = setup({ cooldownMs: 10_000 });
    await guard.request("startup");
    clock.advance(9_999);
    await guard.request("resume");
    expect(calls).toEqual(["startup"]);
    clock.advance(1);
    await guard.request("resume");
    expect(calls).toEqual(["startup", "resume"]);
  });

  it("measures the cooldown from when the run ended, not when it started", async () => {
    const { guard, clock, calls } = setup({
      cooldownMs: 10_000,
      run: async () => {
        clock.advance(60_000); // a long backup
      },
    });
    await guard.request("interval");
    await guard.request("edits");
    expect(calls).toEqual(["interval"]);
  });

  it("never delays the first request, and the default cooldown is 30 s", async () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(30_000);
    const { guard, calls } = setup();
    await guard.request("daily");
    expect(calls).toEqual(["daily"]);
  });

  it("close skips the cooldown but still never overlaps a running backup", async () => {
    const { guard, calls } = setup({ cooldownMs: 10_000 });
    await guard.request("edits");
    await guard.request("close");
    expect(calls).toEqual(["edits", "close"]);

    const gate = deferred();
    const busy = setup({ run: () => gate.promise });
    const first = busy.guard.request("interval");
    await busy.guard.request("close");
    gate.release();
    await first;
    expect(busy.calls).toEqual(["interval"]);
  });

  it("rethrows a failing run, frees the guard, and starts the cooldown (no retry storm)", async () => {
    let fail = true;
    const { guard, clock, calls } = setup({
      cooldownMs: 10_000,
      run: async () => {
        if (fail) throw new Error("disk full");
      },
    });
    await expect(guard.request("interval")).rejects.toThrow("disk full");
    expect(guard.isRunning).toBe(false);
    await guard.request("edits");
    expect(calls).toEqual(["interval"]);
    fail = false;
    clock.advance(10_000);
    await guard.request("edits");
    expect(calls).toEqual(["interval", "edits"]);
  });

  it("logs a held backup lock quietly instead of raising a failure", async () => {
    const { guard, logger } = setup({
      run: async () => {
        throw new LockError("Another backup is running");
      },
    });
    await expect(guard.request("resume")).resolves.toBeUndefined();
    expect(logger.messages("error")).toEqual([]);
    expect(logger.messages("info").some((m) => m.includes("Another backup is running"))).toBe(true);
    expect(guard.isRunning).toBe(false);
  });

  it("with a zero cooldown only prevents overlap", async () => {
    const { guard, calls } = setup({ cooldownMs: 0 });
    await guard.request("edits");
    await guard.request("edits");
    expect(calls).toEqual(["edits", "edits"]);
  });

  it("works as the shared RunRequest of several triggers at once", async () => {
    const gate = deferred();
    const { guard, calls } = setup({ run: () => gate.promise });
    const all = (["startup", "resume", "idle", "create"] as const).map((r) => guard.request(r));
    gate.release();
    await Promise.all(all);
    expect(calls).toEqual(["startup"]);
  });
});
