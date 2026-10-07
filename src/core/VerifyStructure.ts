import { VerificationError } from "../helpers/errors";
import { readZipDirectory } from "../helpers/zipDirectory";
import type { IVaultStore } from "../storage/VaultStore";
import type { Manifest, ManifestPart, VerifyIssue } from "../types";

/**
 * Level 1, structure: every part named in the manifest exists with the recorded size, its ZIP
 * central directory is readable and consistent, and the entries inside match the manifest
 * (same count, same names, nothing extra or missing, sizes equal when unencrypted).
 * Reads each part once; decompresses nothing.
 */
export async function checkStructure(
  store: IVaultStore,
  folderPath: string,
  manifest: Manifest,
  isCancelled: () => boolean,
  onPart: (partIndex: number, partCount: number) => void,
): Promise<{ issues: VerifyIssue[]; entriesChecked: number }> {
  const issues: VerifyIssue[] = [];
  let entriesChecked = 0;

  const known = new Set(manifest.parts.map((p) => p.name));
  for (const e of manifest.entries) {
    if (!known.has(e.part)) {
      issues.push({ path: e.path, message: `Manifest places this file in unknown part ${e.part}` });
    }
  }

  for (const [i, part] of manifest.parts.entries()) {
    if (isCancelled()) break;
    onPart(i + 1, manifest.parts.length);
    entriesChecked += await checkPart(store, folderPath, manifest, part, issues);
  }
  return { issues, entriesChecked };
}

async function checkPart(
  store: IVaultStore,
  folderPath: string,
  manifest: Manifest,
  part: ManifestPart,
  issues: VerifyIssue[],
): Promise<number> {
  const path = `${folderPath}/${part.name}`;
  const problem = (message: string, entry?: string): void => {
    issues.push({ part: part.name, ...(entry ? { path: entry } : {}), message });
  };

  if (!(await store.exists(path))) {
    problem("Part file is missing");
    return 0;
  }
  const data = await store.readBinary(path);
  if (data.length !== part.size) {
    problem(`Part is ${data.length} bytes, the manifest records ${part.size}`);
  }

  let directory;
  try {
    directory = readZipDirectory(data);
  } catch (error) {
    if (!(error instanceof VerificationError)) throw error;
    problem(error.message);
    return 0;
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
  return directory.length;
}
