import { RestoreError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { SettingsProfile } from "../types";
import { loadIndex } from "./BackupIndex";
import { resolveChain, type ResolvedFile, type RestoreSource } from "./ChainResolver";
import { listFileVersions, type FileVersion } from "./FileVersions";
import { executeRestore, type RestoreBatchResult } from "./RestoreBatch";
import { planRestore } from "./RestorePlan";
import { readResolvedFile, type MasterKeyFn } from "./RestoreReader";
import {
  destinationPath,
  type RestoreContext,
  type RestoreControl,
  type RestoreDestination,
  type RestorePreview,
  type RestoreRequest,
  type SafetySnapshotFn,
} from "./RestoreTypes";

export type {
  RestoreControl,
  RestoreProgress,
  PreviewItem,
  RestoreDestination,
  RestorePreview,
  RestoreRequest,
  RestoreScope,
} from "./RestoreTypes";
export { destinationPath };
export type { FileVersion };
export type { RestoreBatchResult } from "./RestoreBatch";

export interface RestoreDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
  yieldIfNeeded?: () => Promise<void>;
  /** Needed only to restore from encrypted backups. Wired to PassphraseService.getKey. */
  deriveMasterKey?: MasterKeyFn;
  /** Runs a backup of the live vault; required to restore into the vault unless the setting is off. */
  safetySnapshot?: SafetySnapshotFn;
}

export interface RestoreFileRequest {
  source: RestoreSource;
  /** Vault-relative path of the file as it was in the backup. */
  path: string;
  destination: RestoreDestination;
  /**
   * Replace a file at the destination whose content differs. Off by default: without it a
   * differing file makes the restore fail and nothing is written.
   */
  overwrite?: boolean;
}

export interface RestoreFolderRequest {
  source: RestoreSource;
  /** Vault-relative folder as it was in the backup. */
  path: string;
  destination: RestoreDestination;
  /** As for files: differing files abort the restore unless this is set. */
  overwrite?: boolean;
}

export interface RestoreFilesRequest {
  source: RestoreSource;
  /** Vault-relative paths as they were in the backup. Every one must exist in it. */
  paths: string[];
  /** Defaults to the restore folder. */
  destination?: RestoreDestination;
  /** Required to replace a file that differs at the destination. */
  overwrite?: boolean;
}

export interface RestoreVaultRequest {
  source: RestoreSource;
  /** Defaults to the restore folder: the live vault is untouched unless `vault` is chosen. */
  destination?: RestoreDestination;
  /**
   * Required to replace differing files or delete extra ones. Without it any difference
   * aborts the restore before a single file is written.
   */
  overwrite?: boolean;
  /** Vault destination only, and only together with `overwrite`: remove files the backup lacks. */
  deleteExtraneous?: boolean;
}

export interface RestoreVersionRequest {
  /** Vault-relative path of the file. */
  path: string;
  /** A `backupId` from `listFileVersions`. */
  backupId: string;
  /** Defaults to the restore folder, where each version lands under its own backup id. */
  destination?: RestoreDestination;
  overwrite?: boolean;
}

export interface RestoreFileResult {
  /** Vault path that was written, or that already held identical content. */
  writtenTo: string;
  backupId: string;
  outcome: "created" | "replaced" | "unchanged";
  bytes: number;
}

export class RestoreEngine {
  constructor(private readonly deps: RestoreDeps) {}

  private context(): RestoreContext {
    const profile = this.deps.getProfile();
    return {
      store: this.deps.store,
      logger: this.deps.logger,
      profile,
      backupFolder: profile.destination.backupFolder,
      yieldIfNeeded: this.deps.yieldIfNeeded ?? createYielder(),
      deriveMasterKey: this.deps.deriveMasterKey,
      safetySnapshot: this.deps.safetySnapshot,
    };
  }

  /**
   * Show what a restore would do, without changing anything: which files would be added,
   * which would replace different content, which would be deleted (if asked), and how many
   * already match. Also confirms every part file needed is present, so a restore cannot
   * fail half way for a missing part.
   */
  async preview(request: RestoreRequest): Promise<RestorePreview> {
    return (await planRestore(this.context(), request)).preview;
  }

  /**
   * Restore one file. The content is read and verified against the manifest hash BEFORE it is
   * written, then written atomically, so a failure never leaves a damaged or half-written
   * file. A differing file at the destination is only replaced with `overwrite`.
   */
  async restoreFile(
    request: RestoreFileRequest,
    control: RestoreControl = {},
  ): Promise<RestoreFileResult> {
    const ctx = this.context();
    const plan = await planRestore(ctx, {
      source: request.source,
      scope: { kind: "file", path: request.path },
      destination: request.destination,
    });
    const batch = await executeRestore(ctx, plan, { overwrite: request.overwrite, ...control });
    const file = plan.chain.files.get(request.path.replace(/\/+$/, "")) as ResolvedFile;
    return {
      writtenTo: destinationPath(batch.destinationRoot, file.path),
      backupId: file.backupId,
      outcome: batch.created > 0 ? "created" : batch.replaced > 0 ? "replaced" : "unchanged",
      bytes: file.entry.size,
    };
  }

  /**
   * Restore every file under a folder, keeping relative paths. All-or-nothing on conflicts:
   * if any file would be replaced and `overwrite` is not set, nothing is written.
   */
  async restoreFolder(
    request: RestoreFolderRequest,
    control: RestoreControl = {},
  ): Promise<RestoreBatchResult> {
    const ctx = this.context();
    const plan = await planRestore(ctx, {
      source: request.source,
      scope: { kind: "folder", path: request.path },
      destination: request.destination,
    });
    const { preview } = plan;
    if (preview.additions.length + preview.changes.length + preview.unchanged === 0) {
      throw new RestoreError(
        `Folder "${request.path}" has no files in backup ${preview.source.id}`,
      );
    }
    return executeRestore(ctx, plan, { overwrite: request.overwrite, ...control });
  }

  /**
   * Restore an explicit selection of files (the restore preview's checkboxes). Nothing outside
   * the selection is written or deleted. A selected file that differs at the destination is
   * only replaced with `overwrite`; if any would be and it is not set, nothing is written.
   */
  async restoreFiles(
    request: RestoreFilesRequest,
    control: RestoreControl = {},
  ): Promise<RestoreBatchResult> {
    const ctx = this.context();
    const plan = await planRestore(ctx, {
      source: request.source,
      scope: { kind: "files", paths: request.paths },
      destination: request.destination ?? { kind: "restore-folder" },
    });
    return executeRestore(ctx, plan, { overwrite: request.overwrite, ...control });
  }

  /**
   * Restore the whole vault as it was at a backup or moment. Goes to the restore folder
   * unless `destination` is explicitly the vault; nothing is overwritten or deleted without
   * `overwrite`.
   */
  async restoreVault(
    request: RestoreVaultRequest,
    control: RestoreControl = {},
  ): Promise<RestoreBatchResult> {
    const destination = request.destination ?? { kind: "restore-folder" };
    if (request.deleteExtraneous && (destination.kind !== "vault" || !request.overwrite)) {
      throw new RestoreError("deleteExtraneous needs the vault destination and overwrite");
    }
    const ctx = this.context();
    const plan = await planRestore(ctx, {
      source: request.source,
      scope: { kind: "all" },
      destination,
      deleteExtraneous: request.deleteExtraneous,
    });
    return executeRestore(ctx, plan, { overwrite: request.overwrite, ...control });
  }

  /**
   * The content a file had in a backup, read into memory (verified against the manifest hash)
   * without writing anything. Rejects when the backup does not contain the file.
   */
  async readFile(source: RestoreSource, path: string): Promise<Uint8Array> {
    const ctx = this.context();
    const index = await loadIndex(ctx.store, ctx.backupFolder);
    const chain = await resolveChain(ctx.store, ctx.backupFolder, index, source);
    const file = chain.files.get(path.replace(/\/+$/, ""));
    if (!file) throw new RestoreError(`"${path}" is not in this backup`);
    return readResolvedFile(ctx.store, ctx.backupFolder, chain, file, ctx.deriveMasterKey);
  }

  /** All distinct versions of a file across intact backups, oldest first. */
  async listFileVersions(path: string): Promise<FileVersion[]> {
    return listFileVersions(this.deps.store, this.context().backupFolder, path);
  }

  /**
   * Restore one specific version of a file: the content it had in the chosen backup. Rejects
   * a backup where the file did not exist. Lands in the restore folder unless told otherwise.
   */
  async restoreFileVersion(
    request: RestoreVersionRequest,
    control: RestoreControl = {},
  ): Promise<RestoreFileResult> {
    return this.restoreFile(
      {
        source: { id: request.backupId },
        path: request.path,
        destination: request.destination ?? { kind: "restore-folder" },
        overwrite: request.overwrite,
      },
      control,
    );
  }
}
