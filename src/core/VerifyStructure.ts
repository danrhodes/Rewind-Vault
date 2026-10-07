import { VerificationError } from "../helpers/errors";
import { readZipDirectory, type ZipDirectoryEntry } from "../helpers/zipDirectory";
import type { Manifest, ManifestPart, VerifyIssue } from "../types";

/** Manifest entries that name a part the manifest does not list. */
export function checkEntryParts(manifest: Manifest): VerifyIssue[] {
  const known = new Set(manifest.parts.map((p) => p.name));
  return manifest.entries
    .filter((e) => !known.has(e.part))
    .map((e) => ({ path: e.path, message: `Manifest places this file in unknown part ${e.part}` }));
}

/**
 * Level 1, structure, for one part whose bytes have been read (`null` = file missing): size
 * equals the manifest, the ZIP central directory is readable and consistent, and the entries
 * inside match the manifest (same count, same names, nothing extra or missing, sizes equal
 * when unencrypted). Decompresses nothing. Returns the directory for the deeper levels, or
 * null when it could not be read.
 */
export function checkPartStructure(
  manifest: Manifest,
  part: ManifestPart,
  data: Uint8Array | null,
  issues: VerifyIssue[],
): ZipDirectoryEntry[] | null {
  const problem = (message: string, entry?: string): void => {
    issues.push({ part: part.name, ...(entry ? { path: entry } : {}), message });
  };
  if (!data) {
    problem("Part file is missing");
    return null;
  }
  if (data.length !== part.size) {
    problem(`Part is ${data.length} bytes, the manifest records ${part.size}`);
  }

  let directory: ZipDirectoryEntry[];
  try {
    directory = readZipDirectory(data);
  } catch (error) {
    if (!(error instanceof VerificationError)) throw error;
    problem(error.message);
    return null;
  }

  const expected = new Map(
    manifest.entries.filter((e) => e.part === part.name).map((e) => [e.path, e]),
  );
  if (directory.length !== part.entryCount) {
    problem(`Part holds ${directory.length} entries, the manifest records ${part.entryCount}`);
  }
  const seen = new Set<string>();
  for (const entry of directory) {
    if (seen.has(entry.name)) {
      problem("Entry appears more than once in the part", entry.name);
      continue;
    }
    seen.add(entry.name);
    const want = expected.get(entry.name);
    if (!want) {
      problem("Entry is in the part but not in the manifest", entry.name);
    } else if (!manifest.encryption.enabled && entry.size !== want.size) {
      problem(`Entry is ${entry.size} bytes, the manifest records ${want.size}`, entry.name);
    }
  }
  for (const name of expected.keys()) {
    if (!seen.has(name)) problem("Entry is in the manifest but missing from the part", name);
  }
  return directory;
}
