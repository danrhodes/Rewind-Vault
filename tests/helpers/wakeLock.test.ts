import { describe, expect, it } from "vitest";
import { acquireWakeLock, type WakeLockApi } from "../../src/helpers/wakeLock";

function fakeApi(options: { refuse?: boolean; releaseFails?: boolean } = {}) {
  const state = { requests: 0, releases: 0 };
  const api: WakeLockApi = {
    async request() {
      state.requests++;
      if (options.refuse) throw new Error("NotAllowedError");
      return {
        async release() {
          state.releases++;
          if (options.releaseFails) throw new Error("already released");
        },
      };
    },
  };
  return { api, state };
}

describe("acquireWakeLock", () => {
  it("returns null without the API", async () => {
    expect(await acquireWakeLock(null)).toBeNull();
  });

  it("returns null, without throwing, when the system refuses", async () => {
    const { api, state } = fakeApi({ refuse: true });
    expect(await acquireWakeLock(api)).toBeNull();
    expect(state.requests).toBe(1);
  });

  it("releases once even if released twice", async () => {
    const { api, state } = fakeApi();
    const release = await acquireWakeLock(api);
    await release?.();
    await release?.();
    expect(state.releases).toBe(1);
  });

  it("swallows a failing release", async () => {
    const { api } = fakeApi({ releaseFails: true });
    const release = await acquireWakeLock(api);
    await expect(release?.()).resolves.toBeUndefined();
  });
});
