import { describe, expect, it } from "vitest";
import { deleteImpact } from "../../src/core/BackupAdmin";
import {
  buildRows,
  describeDelete,
  formatLocalDateTime,
  rowFor,
  summarize,
} from "../../src/ui/backupBrowserModel";
import { DAY, NOW, entry, indexOf } from "../support/retentionFixtures";

const MB = 1024 * 1024;
/** Deterministic, time-zone independent. */
const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const sample = () =>
  indexOf(
    { id: "F1", age: 6 * DAY, size: 10 * MB, pinned: true },
    { id: "D1", age: 5 * DAY, size: 2 * MB, type: "diff", baseId: "F1" },
    { id: "BAD", age: 3 * DAY, size: MB, status: "corrupt" },
    { id: "D2", age: DAY, size: 3 * MB, type: "diff", baseId: "F1" },
  );

describe("rows", () => {
  it("are newest first, with date, type, size and badges", () => {
    const rows = buildRows(sample(), "", fmt);
    expect(rows.map((r) => r.id)).toEqual(["D2", "BAD", "D1", "F1"]);
    expect(rows[0]).toMatchObject({
      title: "2026-10-06 12:00",
      subtitle: "Differential, 3 MB",
      badges: [],
    });
    expect(rows[1]?.badges).toEqual(["corrupt"]);
    expect(rows[3]).toMatchObject({ subtitle: "Full, 10 MB", badges: ["pinned"], pinned: true });
  });

  it("show the milestone label in the title", () => {
    const row = rowFor({ ...entry({ id: "x", age: DAY }), label: "v1.0", pinned: true }, fmt);
    expect(row.title).toBe("2026-10-06 12:00  v1.0");
  });

  it("badge every non-ok status", () => {
    expect(rowFor(entry({ id: "a", age: 1, status: "partial" }), fmt).badges).toEqual([
      "incomplete",
    ]);
    expect(rowFor(entry({ id: "a", age: 1, status: "in-progress" }), fmt).badges).toEqual([
      "in progress",
    ]);
  });

  it("default to a local-time formatter", () => {
    expect(formatLocalDateTime(NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("search", () => {
  it("an empty or blank query shows everything", () => {
    expect(buildRows(sample(), "", fmt)).toHaveLength(4);
    expect(buildRows(sample(), "   ", fmt)).toHaveLength(4);
  });

  it("finds by type, status, pinned, id and date, case-insensitively", () => {
    const ids = (q: string) => buildRows(sample(), q, fmt).map((r) => r.id);
    expect(ids("DIFFERENTIAL")).toEqual(["D2", "D1"]);
    expect(ids("diff")).toEqual(["D2", "D1"]);
    expect(ids("full")).toEqual(["BAD", "F1"]);
    expect(ids("corrupt")).toEqual(["BAD"]);
    expect(ids("pinned")).toEqual(["F1"]);
    expect(ids("d2")).toEqual(["D2"]);
    expect(ids("2026-10-02")).toEqual(["D1"]);
  });

  it("finds by label, and every word must match", () => {
    const index = indexOf({ id: "a", age: 2 * DAY, pinned: true }, { id: "b", age: DAY });
    index.backups[0]!.label = "Before the big refactor";
    expect(buildRows(index, "refactor", fmt).map((r) => r.id)).toEqual(["a"]);
    expect(buildRows(index, "big pinned", fmt).map((r) => r.id)).toEqual(["a"]);
    expect(buildRows(index, "big nothing", fmt)).toEqual([]);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(buildRows(sample(), "zzz", fmt)).toEqual([]);
  });
});

describe("summary", () => {
  it("counts and totals, with singular and empty wording", () => {
    expect(summarize(sample())).toBe("4 backups, 16 MB in total.");
    expect(summarize(indexOf({ id: "a", age: 1, size: MB }))).toBe("1 backup, 1 MB in total.");
    expect(summarize(indexOf())).toBe("No backups yet.");
  });
});

describe("delete confirmation", () => {
  it("a plain delete asks a simple question with no extras", () => {
    const p = describeDelete(deleteImpact(sample(), "D2"), fmt);
    expect(p.message).toContain("Delete the backup from 2026-10-06 12:00");
    expect(p).toMatchObject({ cascade: false, force: false });
    expect(p.message).not.toContain("depend");
  });

  it("warns about dependents and asks for cascade", () => {
    const p = describeDelete(deleteImpact(sample(), "D1"), fmt);
    expect(p.cascade).toBe(true);
    expect(p.message).toContain("1 newer differential backup cannot be restored without it");
  });

  it("warns about pinned milestones and requires force", () => {
    const p = describeDelete(deleteImpact(sample(), "F1"), fmt);
    expect(p).toMatchObject({ cascade: true, force: true });
    expect(p.message).toContain("pinned milestone");
    expect(p.message).toContain("2 newer differential backups");
  });

  it("warns loudly when it is the only intact backup", () => {
    const p = describeDelete(deleteImpact(indexOf({ id: "only", age: DAY }), "only"), fmt);
    expect(p.message).toContain("only intact backup");
  });
});
