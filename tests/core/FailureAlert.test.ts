import { describe, expect, it } from "vitest";
import { DUPLICATE_WINDOW_MS, FailureAlert, localStamp } from "../../src/core/FailureAlert";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { ITextAppender } from "../../src/storage/TextAppender";
import { MockClock } from "../mocks/MockClock";
import { MockLogger } from "../mocks/MockLogger";

function setup(
  tweak: (n: ReturnType<typeof createDefaultProfile>["notifications"]) => void = () => undefined,
  fail = false,
) {
  const settings = createDefaultProfile("desktop").notifications;
  settings.dailyNoteFailureAppend = true;
  settings.dailyNotePath = "Journal/Backup alerts.md";
  tweak(settings);
  const writes: { path: string; text: string }[] = [];
  const appender: ITextAppender = {
    async appendText(path, text) {
      if (fail) throw new Error("disk full");
      writes.push({ path, text });
    },
  };
  const clock = new MockClock(new Date(2026, 9, 8, 9, 5).getTime());
  const logger = new MockLogger();
  const alert = new FailureAlert(appender, clock, logger, () => settings);
  return { alert, writes, clock, logger, settings };
}

describe("FailureAlert", () => {
  it("appends an unchecked task with the local time and the message", async () => {
    const t = setup();
    await t.alert.report("Backup failed: disk full");
    expect(t.writes).toEqual([
      {
        path: "Journal/Backup alerts.md",
        text: "\n- [ ] 2026-10-08 09:05 Rewind Vault: Backup failed: disk full\n",
      },
    ]);
  });

  it("keeps a multi-line message on one line", async () => {
    const t = setup();
    await t.alert.report("first\n  second");
    expect(t.writes[0]?.text).toContain("Rewind Vault: first second\n");
  });

  it("does nothing when the setting is off", async () => {
    const t = setup((n) => (n.dailyNoteFailureAppend = false));
    await t.alert.report("x");
    expect(t.writes).toEqual([]);
  });

  it("refuses a path that is not a safe note path and says so in the log", async () => {
    for (const bad of ["", "notes.txt", "../outside.md", "/abs.md"]) {
      const t = setup((n) => (n.dailyNotePath = bad));
      await t.alert.report("x");
      expect(t.writes, bad).toEqual([]);
      expect(t.logger.messages("warn").join(), bad).toContain("not a valid note path");
    }
  });

  it("writes the same message once per window, and again after it", async () => {
    const t = setup();
    await t.alert.report("same");
    await t.alert.report("same");
    await t.alert.report("other");
    expect(t.writes).toHaveLength(2);
    t.clock.advance(DUPLICATE_WINDOW_MS);
    await t.alert.report("same");
    expect(t.writes).toHaveLength(3);
  });

  it("logs and swallows a write failure", async () => {
    const t = setup(undefined, true);
    await expect(t.alert.report("x")).resolves.toBeUndefined();
    expect(t.logger.messages("warn").join()).toContain("disk full");
  });

  it("formats local stamps with zero padding", () => {
    expect(localStamp(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
  });
});
