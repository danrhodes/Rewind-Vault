import type { PointFile } from "../core/TimeTravel";
import { formatBytes } from "../helpers/format";
import { decodeText, isTextPath } from "./diffModel";

/** Most file rows drawn at once; the search box narrows the rest. Keeps big vaults responsive. */
export const MAX_ROWS = 200;
/** Largest text shown in the preview; bigger files are cut so the dialog stays light. */
export const MAX_PREVIEW_BYTES = 200_000;

/** Files whose path contains the query (case-insensitive). Empty query keeps everything. */
export function filterFiles(files: readonly PointFile[], query: string): PointFile[] {
  const q = query.trim().toLowerCase();
  return q === "" ? [...files] : files.filter((f) => f.path.toLowerCase().includes(q));
}

export function describeListing(total: number, matched: number, shown: number): string {
  if (total === 0) return "This backup holds no files.";
  const count = `${total} file${total === 1 ? "" : "s"}`;
  if (matched === 0) return `No file matches (${count} in this backup).`;
  if (matched < total) {
    return `${matched} of ${count} match${shown < matched ? `, first ${shown} shown` : ""}.`;
  }
  return shown < matched ? `${count}, first ${shown} shown. Search to narrow.` : `${count}.`;
}

export function describeFileRow(file: PointFile, format: (ms: number) => string): string {
  return `${formatBytes(file.size)}, modified ${format(file.mtime)}`;
}

export type PreviewView =
  { kind: "text"; text: string; truncated: boolean } | { kind: "unavailable"; reason: string };

/** What to show for a file's bytes. Never writes; binary and invalid text are explained instead. */
export function buildPreview(path: string, data: Uint8Array): PreviewView {
  if (!isTextPath(path)) return { kind: "unavailable", reason: "Not a text file, so no preview." };
  const truncated = data.length > MAX_PREVIEW_BYTES;
  const slice = truncated ? data.subarray(0, MAX_PREVIEW_BYTES) : data;
  // A cut can land inside a multi-byte character; drop up to 3 trailing bytes and retry.
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    const text = decodeText(slice.subarray(0, slice.length - cut));
    if (text !== null) return { kind: "text", text, truncated };
  }
  return { kind: "unavailable", reason: "The file is not valid UTF-8 text." };
}
