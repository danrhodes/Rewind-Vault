import { describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import { CloseTrigger, type CloseEvents } from "../../src/triggers/CloseTrigger";
import type { TriggerReason } from "../../src/triggers/TriggerTypes";
import type { PlatformKind } from "../../src/types";
import { MockLogger } from "../mocks/MockLogger";
import { MockPlatform } from "../mocks/MockPlatform";

function setup(opts: { kind?: PlatformKind; onClose?: boolean; run?: () => Promise<void> } = {}) {
  const profile = createDefaultProfile(opts.kind ?? "desktop");
  profile.triggers.onClose = opts.onClose ?? true;
  const logger = new MockLogger();
  const run = vi.fn<(r: TriggerReason) => Promise<void>>(opts.run ?? (async () => undefined));
  const listeners = new Set<() => void>();
  const events: CloseEvents = {
    onBeforeClose(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const trigger = new CloseTrigger(
    { clock: { now: () => 0 }, logger, getProfile: () => profile, run },
    new MockPlatform(opts.kind ?? "desktop"),
    events,
  );
  const close = (): void => listeners.forEach((cb) => cb());
  return { trigger, run, logger, close, listeners, profile };
}

describe("CloseTrigger", () => {
  it("asks for one backup with reason 'close' when the window closes", () => {
    const { trigger, run, close } = setup();
    trigger.start();
    close();
    expect(run).toHaveBeenCalledWith("close");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires at most once even if the close signal repeats", () => {
    const { trigger, run, close } = setup();
    trigger.start();
    close();
    close();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the option is off, and picks the option up live", () => {
    const { trigger, run, close, profile } = setup({ onClose: false });
    trigger.start();
    close();
    expect(run).not.toHaveBeenCalled();
    profile.triggers.onClose = true;
    close();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never subscribes on mobile", () => {
    const { trigger, listeners, run, close } = setup({ kind: "mobile" });
    trigger.start();
    expect(trigger.isActive).toBe(false);
    expect(listeners.size).toBe(0);
    close();
    expect(run).not.toHaveBeenCalled();
  });

  it("a failing run is logged, not thrown", async () => {
    const { trigger, close, logger } = setup({
      run: async () => {
        throw new Error("disk gone");
      },
    });
    trigger.start();
    expect(() => close()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.entries.some((e) => e.level === "error" && e.message.includes("disk gone"))).toBe(
      true,
    );
  });

  it("start twice does not double-subscribe; stop unsubscribes and re-arms the once-only flag", () => {
    const { trigger, run, close, listeners } = setup();
    trigger.start();
    trigger.start();
    expect(listeners.size).toBe(1);
    close();
    trigger.stop();
    expect(listeners.size).toBe(0);
    trigger.start();
    close();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
