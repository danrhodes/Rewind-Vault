import { describe, expect, it } from "vitest";
import { describeReport, reportToText } from "../../src/ui/verifyReportModel";
import type { VerifyReport } from "../../src/types";

const base = (over: Partial<VerifyReport> = {}): VerifyReport => ({
  backupId: "B1",
  level: 3,
  startedAt: 1000,
  finishedAt: 66_000,
  result: "pass",
  entriesChecked: 42,
  issues: [],
  ...over,
});

describe("describeReport", () => {
  it("summarises a pass", () => {
    const view = describeReport(base());
    expect(view.passed).toBe(true);
    expect(view.headline).toBe("Passed");
    expect(view.summary).toEqual([
      "Backup: B1",
      "Level 3: SHA-256 against manifest",
      "Entries checked: 42",
      "Took 1m 5s",
    ]);
    expect(view.issues).toEqual([]);
    expect(view.skipped).toEqual([]);
    expect(view.rehearsal).toEqual([]);
  });

  it("counts problems and names where each one is", () => {
    const view = describeReport(
      base({
        result: "fail",
        issues: [
          { path: "a.md", part: "part1.zip", message: "SHA-256 mismatch" },
          { backupId: "B0", message: "base missing" },
        ],
      }),
    );
    expect(view.passed).toBe(false);
    expect(view.headline).toBe("Failed (2 problems)");
    expect(view.issues.map((i) => i.text)).toEqual([
      "part1.zip / a.md: SHA-256 mismatch",
      "B0: base missing",
    ]);
    expect(view.issues.every((i) => i.problem)).toBe(true);
  });

  it("uses the singular for one problem", () => {
    const view = describeReport(base({ result: "fail", issues: [{ message: "bad header" }] }));
    expect(view.headline).toBe("Failed (1 problem)");
    expect(view.issues[0]?.text).toBe("bad header");
  });

  it("says when only a sample was content-checked", () => {
    const view = describeReport(base({ sample: { pct: 10, entriesSampled: 4, entriesTotal: 40 } }));
    expect(view.summary).toContain(
      "Sampled 4 of 40 entries (10%); the rest were not content-checked.",
    );
  });

  it("lists skipped checks without failing the report", () => {
    const view = describeReport(base({ skipped: ["no passphrase for L4"] }));
    expect(view.passed).toBe(true);
    expect(view.skipped).toEqual(["no passphrase for L4"]);
  });

  it("describes a rehearsal", () => {
    const view = describeReport(
      base({
        level: 6,
        rehearsal: {
          filesRestored: 1,
          bytesRestored: 2048,
          matchLive: 1,
          changedSinceBackup: 0,
          missingFromLive: 2,
          notInBackup: 3,
        },
      }),
    );
    expect(view.summary[1]).toBe("Level 6: Restore rehearsal");
    expect(view.rehearsal).toEqual([
      "Restored 1 file (2 KB) in memory.",
      "1 identical to the live vault.",
      "0 edited since the backup (expected).",
      "2 in the backup but gone from the live vault.",
      "3 in the live vault but not in the backup.",
    ]);
  });
});

describe("reportToText", () => {
  it("includes the headline, problems and skipped checks", () => {
    const text = reportToText(
      base({ result: "fail", issues: [{ path: "a.md", message: "bad" }], skipped: ["x"] }),
    );
    expect(text).toContain("Rewind Vault verification: Failed (1 problem)");
    expect(text).toContain("Problems:\n- a.md: bad");
    expect(text).toContain("Skipped:\n- x");
  });

  it("omits empty sections", () => {
    const text = reportToText(base());
    expect(text).not.toContain("Problems:");
    expect(text).not.toContain("Skipped:");
    expect(text).not.toContain("Rehearsal:");
  });
});
