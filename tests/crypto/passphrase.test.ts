import { describe, expect, it } from "vitest";
import { PassphraseService, type PassphrasePolicy } from "../../src/crypto/passphrase";
import { CancelledError, ConfigError } from "../../src/helpers/errors";

function setup(
  overrides: Partial<PassphrasePolicy> = {},
  answers: (string | null)[] = ["hunter2"],
) {
  const policy: PassphrasePolicy = {
    sessionCache: true,
    promptOnDemand: true,
    storedPassphrase: "",
    ...overrides,
  };
  let prompts = 0;
  let derivations = 0;
  const queue = [...answers];
  const service = new PassphraseService(
    () => policy,
    async () => {
      prompts++;
      await Promise.resolve();
      return queue.length > 1 ? (queue.shift() as string | null) : (queue[0] ?? null);
    },
    async (pass, salt, iterations) => {
      derivations++;
      return Uint8Array.from([pass.length, salt[0] ?? 0, iterations % 256, 1]);
    },
  );
  return { service, policy, prompts: () => prompts, derivations: () => derivations };
}

describe("PassphraseService.getPassphrase", () => {
  it("prompts once and caches for the session", async () => {
    const t = setup();
    expect(await t.service.getPassphrase()).toBe("hunter2");
    expect(await t.service.getPassphrase()).toBe("hunter2");
    expect(t.prompts()).toBe(1);
    expect(t.service.hasCachedPassphrase).toBe(true);
  });

  it("prompts every time when session caching is off", async () => {
    const t = setup({ sessionCache: false });
    await t.service.getPassphrase();
    await t.service.getPassphrase();
    expect(t.prompts()).toBe(2);
    expect(t.service.hasCachedPassphrase).toBe(false);
  });

  it("shares one prompt between concurrent callers", async () => {
    const t = setup({ sessionCache: false });
    const results = await Promise.all([t.service.getPassphrase(), t.service.getPassphrase()]);
    expect(results).toEqual(["hunter2", "hunter2"]);
    expect(t.prompts()).toBe(1);
  });

  it("uses a stored passphrase without prompting", async () => {
    const t = setup({ storedPassphrase: "from-settings" });
    expect(await t.service.getPassphrase()).toBe("from-settings");
    expect(t.prompts()).toBe(0);
  });

  it("fails clearly when nothing is available and prompting is off", async () => {
    const t = setup({ promptOnDemand: false });
    await expect(t.service.getPassphrase()).rejects.toBeInstanceOf(ConfigError);
    expect(t.prompts()).toBe(0);
  });

  it("cancel throws CancelledError and is not cached", async () => {
    const t = setup({}, [null, "second try"]);
    await expect(t.service.getPassphrase()).rejects.toBeInstanceOf(CancelledError);
    expect(t.service.hasCachedPassphrase).toBe(false);
    expect(await t.service.getPassphrase()).toBe("second try");
    expect(t.prompts()).toBe(2);
  });

  it("rejects an empty answer", async () => {
    const t = setup({}, [""]);
    await expect(t.service.getPassphrase()).rejects.toBeInstanceOf(ConfigError);
  });

  it("re-reads policy on every call", async () => {
    const t = setup();
    await t.service.getPassphrase();
    t.policy.sessionCache = false;
    await t.service.getPassphrase();
    expect(t.prompts()).toBe(2);
  });
});

describe("PassphraseService.getKey", () => {
  const salt = Uint8Array.from([9, 9, 9]);

  it("derives once per salt and iteration count, then reuses", async () => {
    const t = setup();
    const a = await t.service.getKey(salt, 600_000);
    expect(await t.service.getKey(salt, 600_000)).toBe(a);
    expect(t.derivations()).toBe(1);
    await t.service.getKey(salt, 700_000);
    await t.service.getKey(Uint8Array.from([1]), 600_000);
    expect(t.derivations()).toBe(3);
    expect(t.prompts()).toBe(1);
  });

  it("re-derives every time when caching is off", async () => {
    const t = setup({ sessionCache: false });
    await t.service.getKey(salt, 600_000);
    await t.service.getKey(salt, 600_000);
    expect(t.derivations()).toBe(2);
  });
});

describe("PassphraseService.clear", () => {
  it("forgets the passphrase, zero-fills derived keys and prompts again", async () => {
    const t = setup();
    const key = await t.service.getKey(Uint8Array.from([1]), 600_000);
    expect(key.some((b) => b !== 0)).toBe(true);
    t.service.clear();
    expect(Array.from(key)).toEqual([0, 0, 0, 0]);
    expect(t.service.hasCachedPassphrase).toBe(false);
    await t.service.getPassphrase();
    expect(t.prompts()).toBe(2);
  });
});
