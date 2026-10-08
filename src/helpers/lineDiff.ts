export type DiffOp = { kind: "same" | "add" | "del"; text: string };

/** Above this many cells (old lines x new lines, after trimming) the diff is not computed. */
export const MAX_DIFF_CELLS = 4_000_000;

/** Split text into lines. A trailing newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line diff from `oldText` to `newText` (LCS). "del" lines are only in the old text, "add"
 * lines only in the new. Equal lines at both ends are trimmed first, so a small edit in a big
 * file stays cheap. Returns null when the changed middle is too large to compare.
 */
export function diffLines(oldText: string, newText: string): DiffOp[] | null {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DIFF_CELLS) return null;

  const ops: DiffOp[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  ops.push(...lcsDiff(midA, midB));
  ops.push(...a.slice(endA).map((text): DiffOp => ({ kind: "same", text })));
  return ops;
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i++] as string });
    } else {
      ops.push({ kind: "add", text: b[j++] as string });
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] as string });
  while (j < m) ops.push({ kind: "add", text: b[j++] as string });
  return ops;
}

/** A shown line, or a "gap" row standing for hidden unchanged lines. */
export type CollapsedLine = DiffOp | { kind: "gap"; hidden: number };

/** Keep changed lines plus `context` unchanged lines around them; fold the rest into gaps. */
export function collapseContext(ops: readonly DiffOp[], context = 3): CollapsedLine[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });
  const out: CollapsedLine[] = [];
  let hidden = 0;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (hidden > 0) out.push({ kind: "gap", hidden });
      hidden = 0;
      out.push(op);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) out.push({ kind: "gap", hidden });
  return out;
}
