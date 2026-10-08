import type { RestorePreview } from "../core/RestoreTypes";
import { formatBytes } from "../helpers/format";
import { collapseContext, diffLines, type CollapsedLine } from "../helpers/lineDiff";

export type ChangeKind = "changed" | "only-backup" | "only-vault";

export interface ComparisonRow {
  path: string;
  kind: ChangeKind;
  /** Size in the backup (absent for files only in the vault). */
  backupSize?: number;
  /** Size in the vault now (absent for files only in the backup). */
  currentSize?: number;
}

export interface Comparison {
  rows: ComparisonRow[];
  unchanged: number;
}

/**
 * Turn a restore preview (taken with the vault as destination and deletions requested) into
 * "backup versus the vault now". Rows are sorted by path.
 */
export function buildComparison(preview: RestorePreview): Comparison {
  const rows: ComparisonRow[] = [
    ...preview.changes.map((i): ComparisonRow => ({
      path: i.path,
      kind: "changed",
      backupSize: i.size,
      ...(i.currentSize !== undefined ? { currentSize: i.currentSize } : {}),
    })),
    ...preview.additions.map((i): ComparisonRow => ({
      path: i.path,
      kind: "only-backup",
      backupSize: i.size,
    })),
    ...preview.deletions.map((path): ComparisonRow => ({ path, kind: "only-vault" })),
  ];
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { rows, unchanged: preview.unchanged };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function summarizeComparison(c: Comparison): string {
  if (c.rows.length === 0)
    return `No differences. ${plural(c.unchanged, "file")} match the backup.`;
  const count = (k: ChangeKind): number => c.rows.filter((r) => r.kind === k).length;
  return [
    `${plural(count("changed"), "file")} changed`,
    `${count("only-backup")} deleted since the backup`,
    `${count("only-vault")} new since the backup`,
    `${c.unchanged} unchanged`,
  ].join(", ");
}

const KIND_LABELS: Record<ChangeKind, string> = {
  changed: "changed",
  "only-backup": "deleted since backup",
  "only-vault": "new since backup",
};

export function describeRow(row: ComparisonRow): { title: string; detail: string } {
  const sizes: string[] = [];
  if (row.backupSize !== undefined) sizes.push(`backup ${formatBytes(row.backupSize)}`);
  if (row.currentSize !== undefined) sizes.push(`now ${formatBytes(row.currentSize)}`);
  return { title: row.path, detail: [KIND_LABELS[row.kind], ...sizes].join(", ") };
}

const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "canvas",
  "css",
  "js",
  "ts",
  "yml",
  "yaml",
  "csv",
  "html",
  "xml",
  "base",
]);

/** Whether the path looks like a text file worth diffing line by line. */
export function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** Decode UTF-8, or null when the bytes are not valid text. */
export function decodeText(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

export type FileDiffView =
  | { kind: "text"; lines: CollapsedLine[]; added: number; removed: number }
  | { kind: "unavailable"; reason: string };

/**
 * Line diff of a file: lines marked "-" exist in the backup but not now, "+" exist now but not
 * in the backup. Either side may be absent (file only on one side).
 */
export function describeFileDiff(
  path: string,
  backup: Uint8Array | null,
  current: Uint8Array | null,
): FileDiffView {
  if (!isTextPath(path)) return { kind: "unavailable", reason: "Not a text file." };
  const oldText = backup ? decodeText(backup) : "";
  const newText = current ? decodeText(current) : "";
  if (oldText === null || newText === null) {
    return { kind: "unavailable", reason: "The file is not valid UTF-8 text." };
  }
  const ops = diffLines(oldText, newText);
  if (!ops) return { kind: "unavailable", reason: "The changes are too large to compare here." };
  return {
    kind: "text",
    lines: collapseContext(ops),
    added: ops.filter((o) => o.kind === "add").length,
    removed: ops.filter((o) => o.kind === "del").length,
  };
}
