import { ManifestError } from "../helpers/errors";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupEntry, BackupIndex, VerifyIssue } from "../types";
import { chainFor } from "./BackupIndex";
import { loadManifest } from "./Manifest";

export interface ChainCheck {
  issues: VerifyIssue[];
  /** The other backups this one depends on (base and earlier diffs), oldest first. */
  dependencies: BackupEntry[];
}

/**
 * Level 5, chain, link by link: the full backup a differential builds on is registered, every
 * backup between it and the target is intact (status ok), has a readable manifest that matches
 * the index, and each differential names the same base. Reports every broken link, each tagged
 * with the backup it concerns. Contents of the other backups are checked by the caller.
 *
 * Limit: a backup removed from BOTH its folder and the index cannot be noticed, because
 * nothing records that it existed.
 */
export async function checkChain(
  store: IVaultStore,
  backupFolder: string,
  index: BackupIndex,
  target: BackupEntry,
): Promise<ChainCheck> {
  const issues: VerifyIssue[] = [];
  const problem = (backupId: string, message: string): void => {
    issues.push({ backupId, message });
  };

  const chain = chainFor(index, target.id);
  if (!chain) {
    problem(
      target.id,
      target.type === "diff"
        ? `The full backup it builds on (${target.baseId ?? "none recorded"}) is missing from the index`
        : "Its chain cannot be resolved",
    );
    return { issues, dependencies: [] };
  }

  const base = chain[0] as BackupEntry;
  for (const link of chain) {
    const isTarget = link.id === target.id;
    if (!isTarget && link.status !== "ok") {
      problem(link.id, `Backup in the chain is marked ${link.status}`);
    }
    try {
      const manifest = await loadManifest(store, `${backupFolder}/${link.folder}`);
      if (manifest.id !== link.id || manifest.type !== link.type) {
        problem(link.id, "Its manifest does not match the index");
      }
      if (link.type === "diff" && manifest.baseId !== base.id) {
        problem(
          link.id,
          `Built on ${manifest.baseId ?? "nothing"}, not on the chain base ${base.id}`,
        );
      }
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error;
      problem(link.id, `Its manifest is missing or damaged: ${error.message}`);
    }
  }
  return { issues, dependencies: chain.filter((l) => l.id !== target.id) };
}
