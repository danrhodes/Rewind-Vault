import { describe, expect, it } from "vitest";
import { BackupMirror } from "../../src/core/BackupMirror";
import { MockPlatform } from "../mocks/MockPlatform";
import { rig } from "../support/engineRig";

function setup(keepAwake: boolean, wakeLockAvailable = true) {
  const r = rig((p) => {
    p.misc.keepAwake = keepAwake;
  });
  const events: string[] = [];
  const mirror = new BackupMirror({
    engine: r.engine,
    copier: null,
    platform: new MockPlatform("mobile"),
    logger: r.logger,
    getProfile: () => r.profile,
    store: r.store,
    wakeLock: async () => {
      events.push("acquire");
      return wakeLockAvailable
        ? async () => {
            events.push("release");
          }
        : null;
    },
  });
  return { r, mirror, events };
}

describe("BackupMirror wake lock", () => {
  it("holds the lock for the whole backup and releases it afterwards", async () => {
    const { r, mirror, events } = setup(true);
    await r.store.seed("a.md", "alpha");
    await mirror.run({ mode: "full" });
    expect(events).toEqual(["acquire", "release"]);
  });

  it("is not requested when the setting is off", async () => {
    const { r, mirror, events } = setup(false);
    await r.store.seed("a.md", "alpha");
    await mirror.run({ mode: "full" });
    expect(events).toEqual([]);
  });

  it("releases when the backup fails or is cancelled", async () => {
    const { r, mirror, events } = setup(true);
    await r.store.seed("a.md", "alpha");
    await expect(mirror.run({ mode: "full", isCancelled: () => true })).rejects.toThrow();
    expect(events).toEqual(["acquire", "release"]);
  });

  it("still backs up when the system gives no lock", async () => {
    const { r, mirror, events } = setup(true, false);
    await r.store.seed("a.md", "alpha");
    const result = await mirror.run({ mode: "full" });
    expect(result.status).toBe("completed");
    expect(events).toEqual(["acquire"]);
  });
});
