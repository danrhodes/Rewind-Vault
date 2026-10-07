import { sha256Hex } from "../crypto/hash";
import { BrokenChainError, CancelledError, RestoreError, RewindError } from "../helpers/errors";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupIndex, RehearsalStats, SettingsProfile, VerifyIssue } from "../types";
import type { ResolvedFile } from "./ChainResolver";
import { resolveChain } from "./ChainResolver";
import { readFilesFromPart, type MasterKeyFn } from "./RestoreReader";
import { scanOptionsFromProfile, scanVault } from "./Scanner";

export interface RehearsalContext {
  store: IVaultStore;
  backupFolder: string;
  profile: SettingsProfile;
  index: BackupIndex;
  deriveMasterKey?: MasterKeyFn;
  /** Polls cancel and yields; called after every file. */
  tick: () => Promise<void>;
}

/**
 * Level 6, rehearsal: restore the backup into memory, file by file, exactly as a real restore
 * would (chain resolution, decrypt, inflate, manifest hash check), and compare each result
 * with the live vault. Nothing is written anywhere and no file is kept after its comparison,
 * so memory stays bounded by the largest part.
 *
 * Failures (issues): the chain cannot be resolved, a part cannot be read or decrypted, or a
 * live file that still has the size AND modification time the backup recorded holds different
 * content (the backup and the vault disagree about a file nobody edited).
 * Not failures, only counted: files edited, deleted or created since the backup.
 */
export async function rehearseRestore(
  ctx: RehearsalContext,
  backupId: string,
  issues: VerifyIssue[],
  skipped: string[],
): Promise<RehearsalStats | null> {
  const { store } = ctx;
  let chain;
  try {
    chain = await resolveChain(store, ctx.backupFolder, ctx.index, { id: backupId });
  } catch (error) {
    if (!(error instanceof BrokenChainError)) throw error;
    issues.push({ message: `Rehearsal cannot start: ${error.message}` });
    return null;
  }

  const stats: RehearsalStats = {
    filesRestored: 0,
    bytesRestored: 0,
    matchLive: 0,
    changedSinceBackup: 0,
    missingFromLive: 0,
    notInBackup: 0,
  };

  const groups = new Map<string, ResolvedFile[]>();
  for (const f of chain.files.values()) {
    const key = `${f.folder}/${f.entry.part}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  for (const [partKey, files] of groups) {
    try {
      for await (const { file, data } of readFilesFromPart(
        store,
        ctx.backupFolder,
        chain,
        files,
        ctx.deriveMasterKey,
      )) {
        stats.filesRestored++;
        stats.bytesRestored += data.length;
        await compareWithLive(ctx, file, data, stats, issues);
        await ctx.tick();
      }
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      if (error instanceof RestoreError && /no passphrase/.test(error.message)) {
        skipped.push("Rehearsal of an encrypted backup needs the passphrase; not run");
        return null;
      }
      const message = error instanceof RewindError ? error.message : "unreadable part";
      issues.push({ part: partKey, message: `Restore rehearsal failed: ${message}` });
    }
  }

  const live = await scanVault(store, scanOptionsFromProfile(ctx.profile), async () => undefined);
  stats.notInBackup = live.filter((f) => !chain.files.has(f.path)).length;
  return stats;
}

async function compareWithLive(
  ctx: RehearsalContext,
  file: ResolvedFile,
  data: Uint8Array,
  stats: RehearsalStats,
  issues: VerifyIssue[],
): Promise<void> {
  const live = await ctx.store.stat(file.path);
  if (!live || live.type !== "file") {
    stats.missingFromLive++;
    return;
  }
  if (
    live.size === data.length &&
    sha256Hex(await ctx.store.readBinary(file.path)) === file.entry.sha256
  ) {
    stats.matchLive++;
    return;
  }
  if (live.size === file.entry.size && live.mtime === file.entry.mtime) {
    issues.push({
      path: file.path,
      backupId: file.backupId,
      message:
        "Live file has the size and modification time the backup recorded but different content",
    });
    return;
  }
  stats.changedSinceBackup++;
}
