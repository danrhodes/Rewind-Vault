import { describe, expect, it } from "vitest";
import type { RestorePreview } from "../../src/core/RestoreTypes";
import { collapseContext, diffLines, splitLines } from "../../src/helpers/lineDiff";
import {
  buildComparison,
  decodeText,
  describeFileDiff,
  describeRow,
  isTextPath,
  summarizeComparison,
} from "../../src/ui/diffModel";

const enc = (s: string) => new TextEncoder().encode(s);

const kinds = (ops: ReturnType<typeof diffLines>) => (ops ?? []).map((o) => `${o.kind}:${o.text}`);

describe("diffLines", () => {
  it("splits lines without a phantom last line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("finds a changed, added and removed line", () => {
    expect(kinds(diffLines("a\nb\nc\n", "a\nB\nc\nd\n"))).toEqual([
      "same:a",
      "del:b",
      "add:B",
      "same:c",
      "add:d",
    ]);
  });

  it("is all same for equal text and all add / del against nothing", () => {
    expect(kinds(diffLines("x\ny", "x\ny"))).toEqual(["same:x", "same:y"]);
    expect(kinds(diffLines("", "x"))).toEqual(["add:x"]);
    expect(kinds(diffLines("x", ""))).toEqual(["del:x"]);
  });

  it("returns null when the changed middle is too large", () => {
    const big = (p: string) => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join("\n");
    expect(diffLines(big("a"), big("b"))).toBeNull();
  });

  it("folds unchanged lines far from a change into gaps", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const ops = diffLines(old, old.replace("l10", "X")) ?? [];
    const out = collapseContext(ops, 2);
    expect(out[0]).toEqual({ kind: "gap", hidden: 8 });
    expect(out.filter((l) => l.kind === "gap")).toHaveLength(2);
    expect(out.some((l) => l.kind === "del" && "text" in l && l.text === "l10")).toBe(true);
  });
});

const preview = (): RestorePreview => ({
  source: {} as RestorePreview["source"],
  destinationRoot: "",
  additions: [{ path: "gone.md", size: 2048, backupId: "B1" }],
  changes: [{ path: "a.md", size: 10, backupId: "B1", currentSize: 30 }],
  deletions: ["new.md"],
  unchanged: 5,
  bytesToWrite: 0,
});

describe("comparison", () => {
  it("lists every kind of difference sorted by path", () => {
    const c = buildComparison(preview());
    expect(c.rows.map((r) => `${r.path}:${r.kind}`)).toEqual([
      "a.md:changed",
      "gone.md:only-backup",
      "new.md:only-vault",
    ]);
    expect(c.unchanged).toBe(5);
  });

  it("summarises, including the no-difference case", () => {
    expect(summarizeComparison(buildComparison(preview()))).toBe(
      "1 file changed, 1 deleted since the backup, 1 new since the backup, 5 unchanged",
    );
    expect(summarizeComparison({ rows: [], unchanged: 1 })).toBe(
      "No differences. 1 file match the backup.",
    );
  });

  it("describes a row with both sizes", () => {
    const row = buildComparison(preview()).rows[0]!;
    expect(describeRow(row)).toEqual({
      title: "a.md",
      detail: "changed, backup 10 B, now 30 B",
    });
  });
});

describe("file diff view", () => {
  it("recognises text paths", () => {
    expect(isTextPath("notes/a.MD")).toBe(true);
    expect(isTextPath("img.png")).toBe(false);
    expect(isTextPath("noext")).toBe(false);
  });

  it("rejects invalid UTF-8", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
    expect(decodeText(enc("héllo"))).toBe("héllo");
  });

  it("counts added and removed lines (backup is the old side)", () => {
    const view = describeFileDiff("a.md", enc("one\ntwo"), enc("one\n2\nthree"));
    expect(view).toMatchObject({ kind: "text", added: 2, removed: 1 });
  });

  it("treats a missing side as empty", () => {
    expect(describeFileDiff("a.md", enc("x\ny"), null)).toMatchObject({ removed: 2, added: 0 });
    expect(describeFileDiff("a.md", null, enc("x"))).toMatchObject({ removed: 0, added: 1 });
  });

  it("is unavailable for binary files and non-text bytes", () => {
    expect(describeFileDiff("a.png", enc("x"), enc("y")).kind).toBe("unavailable");
    expect(describeFileDiff("a.md", new Uint8Array([0xff]), enc("y")).kind).toBe("unavailable");
  });
});
