import { describe, expect, it } from "vitest";
import type { CompletedResult } from "../../src/core/RunTypes";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { NotificationLevel, VerifyReport } from "../../src/types";
import { Notifier, type NoticeKind } from "../../src/ui/notify";

function setup(
  level: NotificationLevel,
  tweak: (p: ReturnType<typeof createDefaultProfile>) => void = () => undefined,
) {
  const profile = createDefaultProfile("desktop");
  profile.notifications.level = level;
  tweak(profile);
  const shown: { message: string; timeoutMs?: number }[] = [];
  const notifier = new Notifier(
    (message, timeoutMs) => shown.push({ message, timeoutMs }),
    () => profile,
  );
  return { notifier, shown, profile };
}

const result = (extra: Partial<CompletedResult> = {}): CompletedResult => ({
  status: "completed",
  backupId: "2026-10-07T10-00-00_full",
  type: "full",
  fileCount: 3,
  bytes: 2048,
  skippedFiles: [],
  nonDestructive: false,
  ...extra,
});

const failedReport = (): VerifyReport => ({
  backupId: "x",
  level: 2,
  startedAt: 0,
  finishedAt: 1,
  result: "fail",
  entriesChecked: 3,
  issues: [{ message: "bad", path: "a.md" }],
});

const KINDS: NoticeKind[] = ["error", "warning", "info", "success"];

describe("Notifier levels", () => {
  it("silent shows nothing, not even errors", () => {
    const { notifier, shown } = setup("silent");
    for (const k of KINDS) notifier.notify(k, "x");
    expect(shown).toEqual([]);
  });

  it("errors shows errors and warnings only", () => {
    const { notifier, shown } = setup("errors");
    for (const k of KINDS) notifier.notify(k, k);
    expect(shown.map((s) => s.message)).toEqual(["Rewind Vault: error", "Rewind Vault: warning"]);
  });

  it("verbose shows everything", () => {
    const { notifier, shown } = setup("verbose");
    for (const k of KINDS) notifier.notify(k, k);
    expect(shown).toHaveLength(4);
  });

  it("reads the level live", () => {
    const { notifier, shown, profile } = setup("silent");
    notifier.error("one");
    profile.notifications.level = "errors";
    notifier.error("two");
    expect(shown.map((s) => s.message)).toEqual(["Rewind Vault: two"]);
    expect(notifier.wouldShow("success")).toBe(false);
  });

  it("errors stay on screen longer than other notices", () => {
    const { notifier, shown } = setup("verbose");
    notifier.error("e");
    notifier.info("i");
    expect(shown[0]?.timeoutMs).toBeGreaterThan(5000);
    expect(shown[1]?.timeoutMs).toBeUndefined();
  });

  it("a throwing show function never throws into the caller", () => {
    const profile = createDefaultProfile("desktop");
    const notifier = new Notifier(
      () => {
        throw new Error("ui gone");
      },
      () => profile,
    );
    expect(() => notifier.error("x")).not.toThrow();
  });

  it("failure() names the action and the error, and handles non-Error values", () => {
    const { notifier, shown } = setup("errors");
    notifier.failure("Backup", new Error("disk full"));
    notifier.failure("Restore", "plain string");
    expect(shown[0]?.message).toBe("Rewind Vault: Backup failed: disk full");
    expect(shown[1]?.message).toBe("Rewind Vault: Restore failed: plain string");
  });
});

describe("Notifier.backupResult", () => {
  it("success is verbose only, with file count and size", () => {
    const quiet = setup("errors");
    quiet.notifier.backupResult(result());
    expect(quiet.shown).toEqual([]);
    const loud = setup("verbose");
    loud.notifier.backupResult(result({ fileCount: 1, bytes: 2048 }));
    expect(loud.shown[0]?.message).toContain("1 file,");
    expect(loud.shown[0]?.message).toContain("2");
  });

  it("a skipped run is info (verbose only)", () => {
    const loud = setup("verbose");
    loud.notifier.backupResult({ status: "skipped", reason: "no-changes" });
    expect(loud.shown[0]?.message).toContain("No changes");
    const quiet = setup("errors");
    quiet.notifier.backupResult({ status: "skipped", reason: "no-changes" });
    expect(quiet.shown).toEqual([]);
  });

  it("a failed verification is an error shown at the errors level", () => {
    const { notifier, shown } = setup("errors");
    notifier.backupResult(result({ verification: failedReport() }));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.message).toContain("FAILED verification");
    expect(shown[0]?.message).toContain("2026-10-07T10-00-00_full");
  });

  it("onFailureNotify off suppresses the verification error", () => {
    const { notifier, shown } = setup("verbose", (p) => {
      p.verification.onFailureNotify = false;
    });
    notifier.backupResult(result({ verification: failedReport() }));
    expect(shown.some((s) => s.message.includes("FAILED"))).toBe(false);
  });

  it("a passing verification adds no notice", () => {
    const { notifier, shown } = setup("errors");
    notifier.backupResult(
      result({ verification: { ...failedReport(), result: "pass", issues: [] } }),
    );
    expect(shown).toEqual([]);
  });

  it("warns about a forced full backup and about skipped files at the errors level", () => {
    const { notifier, shown } = setup("errors");
    notifier.backupResult(
      result({ forcedFullReason: "state unreadable", skippedFiles: ["big.bin"] }),
    );
    expect(shown.map((s) => s.message).join("|")).toContain("1 file(s) were left out");
    // A forced full backup is only information (the first backup always is one).
    expect(shown.map((s) => s.message).join("|")).not.toContain("full backup instead");
    const loud = setup("verbose");
    loud.notifier.backupResult(result({ forcedFullReason: "state unreadable" }));
    expect(loud.shown.map((s) => s.message).join("|")).toContain("full backup instead");
  });

  it("silent shows none of it", () => {
    const { notifier, shown } = setup("silent");
    notifier.backupResult(result({ verification: failedReport(), skippedFiles: ["a"] }));
    expect(shown).toEqual([]);
  });
});

describe("error sink", () => {
  function withSink(level: NotificationLevel, sinkThrows = false) {
    const profile = createDefaultProfile("desktop");
    profile.notifications.level = level;
    const errors: string[] = [];
    const shown: string[] = [];
    const notifier = new Notifier(
      (m) => shown.push(m),
      () => profile,
      (message) => {
        errors.push(message);
        if (sinkThrows) throw new Error("sink broke");
      },
    );
    return { notifier, errors, shown };
  }

  it("receives errors even when notices are silent, and nothing else", () => {
    const t = withSink("silent");
    t.notifier.error("it broke");
    t.notifier.warning("careful");
    t.notifier.info("fyi");
    t.notifier.success("done");
    expect(t.errors).toEqual(["it broke"]);
    expect(t.shown).toEqual([]);
  });

  it("receives failures reported through failure()", () => {
    const t = withSink("errors");
    t.notifier.failure("Backup", new Error("disk full"));
    expect(t.errors).toEqual(["Backup failed: disk full"]);
    expect(t.shown).toHaveLength(1);
  });

  it("a throwing sink does not stop the notice", () => {
    const t = withSink("errors", true);
    expect(() => t.notifier.error("x")).not.toThrow();
    expect(t.shown).toHaveLength(1);
  });
});
