import { formatBytes, formatDuration } from "../helpers/format";
import type { VerifyLevel, VerifyReport } from "../types";

export const LEVEL_NAMES: Record<VerifyLevel, string> = {
  1: "Structure",
  2: "CRC",
  3: "SHA-256 against manifest",
  4: "Decrypt check",
  5: "Chain check",
  6: "Restore rehearsal",
};

export interface ReportLine {
  text: string;
  /** Set for lines that describe a problem, so the UI can mark them. */
  problem?: boolean;
}

export interface ReportView {
  /** Short headline, e.g. "Passed" or "Failed (2 problems)". */
  headline: string;
  passed: boolean;
  /** Facts about the run: backup, level, entries, duration, sampling. */
  summary: string[];
  issues: ReportLine[];
  skipped: string[];
  /** Level 6 results, empty otherwise. */
  rehearsal: string[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const issueText = (issue: VerifyReport["issues"][number]): string => {
  const where = [issue.backupId, issue.part, issue.path].filter((p): p is string => !!p);
  return where.length > 0 ? `${where.join(" / ")}: ${issue.message}` : issue.message;
};

const rehearsalLines = (report: VerifyReport): string[] => {
  const r = report.rehearsal;
  if (!r) return [];
  return [
    `Restored ${plural(r.filesRestored, "file")} (${formatBytes(r.bytesRestored)}) in memory.`,
    `${r.matchLive} identical to the live vault.`,
    `${r.changedSinceBackup} edited since the backup (expected).`,
    `${r.missingFromLive} in the backup but gone from the live vault.`,
    `${r.notInBackup} in the live vault but not in the backup.`,
  ];
};

/** Turns a VerifyReport into plain text for the dialog. Pure: no UI, no clock, no time zone. */
export function describeReport(report: VerifyReport): ReportView {
  const passed = report.result === "pass";
  const count = report.issues.length;
  const summary = [
    `Backup: ${report.backupId}`,
    `Level ${report.level}: ${LEVEL_NAMES[report.level]}`,
    `Entries checked: ${report.entriesChecked}`,
    `Took ${formatDuration(report.finishedAt - report.startedAt)}`,
  ];
  if (report.sample) {
    const s = report.sample;
    summary.push(
      `Sampled ${s.entriesSampled} of ${s.entriesTotal} entries (${s.pct}%); the rest were not content-checked.`,
    );
  }
  return {
    headline: passed ? "Passed" : `Failed (${plural(count, "problem")})`,
    passed,
    summary,
    issues: report.issues.map((i) => ({ text: issueText(i), problem: true })),
    skipped: report.skipped ?? [],
    rehearsal: rehearsalLines(report),
  };
}

/** The report as plain text for the clipboard, for bug reports. */
export function reportToText(report: VerifyReport): string {
  const view = describeReport(report);
  const lines = [`Rewind Vault verification: ${view.headline}`, ...view.summary];
  if (view.rehearsal.length > 0) lines.push("", "Rehearsal:", ...view.rehearsal);
  if (view.issues.length > 0) lines.push("", "Problems:", ...view.issues.map((i) => `- ${i.text}`));
  if (view.skipped.length > 0) lines.push("", "Skipped:", ...view.skipped.map((s) => `- ${s}`));
  return lines.join("\n");
}
