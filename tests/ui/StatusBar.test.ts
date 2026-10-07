import { describe, expect, it } from "vitest";
import type { RunProgress } from "../../src/core/RunTypes";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { PlatformKind } from "../../src/types";
import { StatusBar, formatAgo, type StatusBarItem } from "../../src/ui/StatusBar";
import { MockClock } from "../mocks/MockClock";
import { MockPlatform } from "../mocks/MockPlatform";

function setup(kind: PlatformKind = "desktop", enabled = true) {
  const profile = createDefaultProfile(kind);
  profile.notifications.statusBar = enabled;
  const clock = new MockClock(1_000_000_000);
  const items: { text: string; removed: boolean }[] = [];
  let created = 0;
  const bar = new StatusBar({
    platform: new MockPlatform(kind),
    clock,
    getProfile: () => profile,
    createItem: (): StatusBarItem => {
      created++;
      const record = { text: "", removed: false };
      items.push(record);
      return {
        setText: (t) => {
          record.text = t;
        },
        remove: () => {
          record.removed = true;
        },
      };
    },
  });
  return { bar, profile, clock, items, created: () => created };
}

const progress = (extra: Partial<RunProgress> = {}): RunProgress => ({
  phase: "packing",
  partIndex: 1,
  partCount: 1,
  filesDone: 5,
  filesTotal: 10,
  bytesDone: 50,
  bytesTotal: 200,
  ...extra,
});

describe("formatAgo", () => {
  it("formats minutes, hours and days", () => {
    expect(formatAgo(0)).toBe("just now");
    expect(formatAgo(59_999)).toBe("just now");
    expect(formatAgo(60_000)).toBe("1 min ago");
    expect(formatAgo(59 * 60_000)).toBe("59 min ago");
    expect(formatAgo(60 * 60_000)).toBe("1 h ago");
    expect(formatAgo(47 * 3_600_000)).toBe("47 h ago");
    expect(formatAgo(48 * 3_600_000)).toBe("2 d ago");
    expect(formatAgo(-5)).toBe("just now");
  });
});

describe("StatusBar", () => {
  it("shows 'no backup yet' and then how long ago the last backup was", () => {
    const { bar, items, clock } = setup();
    bar.setIdle(null);
    expect(items[0]?.text).toBe("Rewind Vault: no backup yet");
    bar.setIdle(clock.now() - 5 * 60_000);
    expect(items[0]?.text).toBe("Rewind Vault: backed up 5 min ago");
    clock.advance(10 * 60_000);
    bar.refresh();
    expect(items[0]?.text).toBe("Rewind Vault: backed up 15 min ago");
  });

  it("shows progress for each phase, with a percentage while packing", () => {
    const { bar, items } = setup();
    bar.setProgress(progress({ phase: "scanning" }));
    expect(items[0]?.text).toContain("scanning");
    bar.setProgress(progress());
    expect(items[0]?.text).toBe("Rewind Vault: backing up 25%");
    bar.setProgress(progress({ bytesDone: 999, bytesTotal: 200 }));
    expect(items[0]?.text).toBe("Rewind Vault: backing up 100%");
    bar.setProgress(progress({ bytesTotal: 0 }));
    expect(items[0]?.text).toBe("Rewind Vault: backing up 0%");
    bar.setProgress(progress({ phase: "finalizing" }));
    expect(items[0]?.text).toContain("finishing");
    bar.setProgress(progress({ phase: "verifying" }));
    expect(items[0]?.text).toContain("verifying");
  });

  it("shows a failure", () => {
    const { bar, items } = setup();
    bar.setError();
    expect(items[0]?.text).toBe("Rewind Vault: last backup failed");
  });

  it("creates the item once and reuses it", () => {
    const { bar, created } = setup();
    bar.setIdle(null);
    bar.setProgress(progress());
    bar.setIdle(5);
    expect(created()).toBe(1);
  });

  it("is never created on mobile", () => {
    const { bar, created } = setup("mobile", true);
    bar.setIdle(null);
    bar.setProgress(progress());
    bar.setError();
    expect(created()).toBe(0);
    expect(bar.isVisible).toBe(false);
  });

  it("is not created while the setting is off", () => {
    const { bar, created } = setup("desktop", false);
    bar.setIdle(null);
    expect(created()).toBe(0);
  });

  it("turning the setting off removes the item and turning it on adds a new one", () => {
    const { bar, profile, items } = setup();
    bar.setIdle(null);
    profile.notifications.statusBar = false;
    bar.refresh();
    expect(items[0]?.removed).toBe(true);
    expect(bar.isVisible).toBe(false);
    profile.notifications.statusBar = true;
    bar.refresh();
    expect(items).toHaveLength(2);
    expect(items[1]?.text).toBe("Rewind Vault: no backup yet");
  });

  it("does not rewrite the text when nothing changed", () => {
    const { bar, items } = setup();
    let writes = 0;
    bar.setIdle(null);
    const record = items[0]!;
    let current = record.text;
    Object.defineProperty(record, "text", {
      get: () => current,
      set: (v: string) => {
        writes++;
        current = v;
      },
    });
    bar.refresh();
    bar.refresh();
    expect(writes).toBe(0);
  });

  it("dispose removes the item, and a later update recreates it", () => {
    const { bar, items } = setup();
    bar.setIdle(null);
    bar.dispose();
    expect(items[0]?.removed).toBe(true);
    bar.setIdle(null);
    expect(items).toHaveLength(2);
  });
});
