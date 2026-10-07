import { describe, expect, it } from "vitest";
import { createServices } from "../src/services";
import { createDefaultSettings } from "../src/settings/defaults";
import { readText } from "../src/storage/VaultStore";
import { MockClock } from "./mocks/MockClock";
import { MockLogger } from "./mocks/MockLogger";
import { MockPlatform } from "./mocks/MockPlatform";
import { MockVaultStore } from "./mocks/MockVaultStore";

describe("createServices", () => {
  it("wires dependencies and resolves the platform profile", () => {
    const settings = createDefaultSettings();
    settings.mobile.conditions.minBatteryPct = 33;
    const store = new MockVaultStore();
    const platform = new MockPlatform("mobile");
    const logger = new MockLogger();
    const clock = new MockClock();
    const s = createServices({
      settings,
      store,
      platform,
      logger,
      clock,
      saveSettings: async () => undefined,
    });
    expect(s.store).toBe(store);
    expect(s.platform).toBe(platform);
    expect(s.logger).toBe(logger);
    expect(s.clock).toBe(clock);
    expect(s.getProfile().conditions.minBatteryPct).toBe(33);
  });

  it("getProfile reflects later settings changes", () => {
    const settings = createDefaultSettings();
    const s = createServices({
      settings,
      store: new MockVaultStore(),
      platform: new MockPlatform("desktop"),
      saveSettings: async () => undefined,
    });
    settings.desktop.retention.keepLast = 42;
    expect(s.getProfile().retention.keepLast).toBe(42);
  });

  it("saveSettings delegates to the provided function", async () => {
    let saved = 0;
    const s = createServices({
      settings: createDefaultSettings(),
      store: new MockVaultStore(),
      platform: new MockPlatform(),
      logger: new MockLogger(),
      saveSettings: async () => void saved++,
    });
    await s.saveSettings();
    expect(saved).toBe(1);
  });

  it("default logger writes to <backupFolder>/log.txt using the injected clock", async () => {
    const store = new MockVaultStore();
    const clock = new MockClock(Date.UTC(2026, 9, 7, 12, 0, 0));
    const s = createServices({
      settings: createDefaultSettings(),
      store,
      platform: new MockPlatform(),
      clock,
      saveSettings: async () => undefined,
    });
    s.logger.info("hello");
    s.logger.debug("hidden at info level");
    await new Promise((r) => setTimeout(r, 10));
    expect(await readText(store, "backup/log.txt")).toBe("2026-10-07T12:00:00.000Z INFO hello\n");
  });

  it("passphrase service follows the profile's encryption settings and can be cleared", async () => {
    const settings = createDefaultSettings();
    settings.desktop.encryption.passphrase = "stored";
    let prompts = 0;
    const s = createServices({
      settings,
      store: new MockVaultStore(),
      platform: new MockPlatform("desktop"),
      logger: new MockLogger(),
      saveSettings: async () => undefined,
      promptPassphrase: async () => {
        prompts++;
        return "typed";
      },
    });
    expect(await s.passphrase.getPassphrase()).toBe("stored");
    expect(s.passphrase.hasCachedPassphrase).toBe(true);
    s.passphrase.clear();
    expect(s.passphrase.hasCachedPassphrase).toBe(false);
    settings.desktop.encryption.passphrase = "";
    expect(await s.passphrase.getPassphrase()).toBe("typed");
    expect(prompts).toBe(1);
  });

  it("without a prompt provider, an on-demand prompt counts as cancelled", async () => {
    const s = createServices({
      settings: createDefaultSettings(),
      store: new MockVaultStore(),
      platform: new MockPlatform(),
      logger: new MockLogger(),
      saveSettings: async () => undefined,
    });
    await expect(s.passphrase.getPassphrase()).rejects.toThrow("cancelled");
  });
});
