import { sha256Hex } from "../crypto/hash";
import { BrokenChainError, RestoreError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import { isInsideFolder } from "../helpers/glob";
import { isSafeRelPath } from "../helpers/validate";
import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { BackupEntry, SettingsProfile } from "../types";
import { loadIndex } from "./BackupIndex";
import { resolveChain, type ResolvedFile, type RestoreSource } from "./ChainResolver";
import { readResolvedFile, type MasterKeyFn } from "./RestoreReader";
import { scanOptionsFromProfile, scanVault } from "./Scanner";
import { writeAtomic } from "../storage/AtomicWriter";

export type RestoreScope =
  { kind: "all" } | { kind: "file"; path: string } | { kind: "folder"; path: string };

/**
 * Where restored files go. The restore folder is the safe default: files land in
 * `<restoreFolder>/<backup id>/` and nothing in the live vault is touched. Writing into the
 * vault itself is a separate, explicit choice.
 */
export type RestoreDestination = { kind: "restore-folder" } | { kind: "vault" };

export interface RestoreRequest {
  source: RestoreSource;
  scope: RestoreScope;
  destination: RestoreDestination;
  /**
   * Vault destination only: also remove files that the backup does not contain, so the
   * result matches the backup exactly. Off by default.
   */
  deleteExtraneous?: boolean;
}

export interface PreviewItem {
  path: string;
  /** Size of the restored file. */
  size: number;
  /** Backup that stores the version that would be restored. */
  backupId: string;
  /** Size of the file currently at the destination, for changes. */
  currentSize?: number;
}

export interface RestorePreview {
  source: BackupEntry;
  /** "" for the vault, otherwise the folder restored files are written under. */
  destinationRoot: string;
  /** In the backup, absent at the destination. */
  additions: PreviewItem[];
  /** In both, with different content. */
  changes: PreviewItem[];
  /** At the destination only; listed only when `deleteExtraneous` was requested. */
  deletions: string[];
  /** In both, identical. */
  unchanged: number;
  /** Bytes that would be written (additions plus changes). */
  bytesToWrite: number;
}

export interface RestoreDeps {
  store: IVaultStore;
  logger: ILogger;
  clock: IClock;
  getProfile: () => SettingsProfile;
  yieldIfNeeded?: () => Promise<void>;
  /** Needed only to restore from encrypted backups. Wired to PassphraseService.getKey. */
  deriveMasterKey?: MasterKeyFn;
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

export interface RestoreFileResult {
  /** Vault path that was written, or that already held identical content. */
  writtenTo: string;
  backupId: string;
  outcome: "created" | "replaced" | "unchanged";
  bytes: number;
}

/** Where a vault-relative path ends up for a destination. */
export function destinationPath(root: string, path: string): string {
  return root === "" ? path : `${root}/${path}`;
}

function normaliseScope(scope: RestoreScope): RestoreScope {
  if (scope.kind === "all") return scope;
  const path = scope.path.replace(/\/+$/, "");
  if (!isSafeRelPath(path)) throw new RestoreError(`"${scope.path}" is not a valid vault path`);
  return { kind: scope.kind, path };
}

function inScope(scope: RestoreScope, path: string): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "file") return path === scope.path;
  return isInsideFolder(path, scope.path) && path !== scope.path;
}

export class RestoreEngine {
  constructor(private readonly deps: RestoreDeps) {}

  /**
   * Show what a restore would do, without changing anything: which files would be added,
   * which would replace different content, which would be deleted (if asked), and how many
   * already match. Also confirms every part file needed is present, so a restore cannot
   * fail half way for a missing part.
   */
  async preview(request: RestoreRequest): Promise<RestorePreview> {
    const { store } = this.deps;
    const profile = this.deps.getProfile();
    const backupFolder = profile.destination.backupFolder;
    const scope = normaliseScope(request.scope);

    const index = await loadIndex(store, backupFolder);
    const chain = await resolveChain(store, backupFolder, index, request.source);
    const wanted = [...chain.files.values()].filter((f) => inScope(scope, f.path));
    if (scope.kind === "file" && wanted.length === 0) {
      throw new RestoreError(`"${scope.path}" is not in backup ${chain.target.id}`);
    }
    await this.assertPartsPresent(backupFolder, wanted);

    const root =
      request.destination.kind === "vault"
        ? ""
        : `${profile.destination.restoreFolder}/${chain.target.id}`;
    const yieldIfNeeded = this.deps.yieldIfNeeded ?? createYielder();

    const preview: RestorePreview = {
      source: chain.target,
      destinationRoot: root,
      additions: [],
      changes: [],
      deletions: [],
      unchanged: 0,
      bytesToWrite: 0,
    };

    for (const file of wanted.sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const item: PreviewItem = {
        path: file.path,
        size: file.entry.size,
        backupId: file.backupId,
      };
      const current = await store.stat(destinationPath(root, file.path));
      if (!current || current.type !== "file") {
        preview.additions.push(item);
        preview.bytesToWrite += item.size;
      } else if (await this.differs(destinationPath(root, file.path), current.size, file)) {
        preview.changes.push({ ...item, currentSize: current.size });
        preview.bytesToWrite += item.size;
      } else {
        preview.unchanged++;
      }
      await yieldIfNeeded();
    }

    if (request.deleteExtraneous && request.destination.kind === "vault" && scope.kind !== "file") {
      const keep = new Set(wanted.map((f) => f.path));
      const live = await scanVault(store, scanOptionsFromProfile(profile), yieldIfNeeded);
      preview.deletions = live.map((f) => f.path).filter((p) => inScope(scope, p) && !keep.has(p));
    }
    return preview;
  }

  /**
   * Restore one file. The content is read and verified against the manifest hash BEFORE
   * anything is written, then written atomically, so a failure never leaves a damaged or
   * half-written file. A differing file at the destination is only replaced with `overwrite`.
   */
  async restoreFile(request: RestoreFileRequest): Promise<RestoreFileResult> {
    const { store } = this.deps;
    const profile = this.deps.getProfile();
    const backupFolder = profile.destination.backupFolder;
    const path = request.path.replace(/\/+$/, "");
    if (!isSafeRelPath(path)) throw new RestoreError(`"${request.path}" is not a valid vault path`);

    const index = await loadIndex(store, backupFolder);
    const chain = await resolveChain(store, backupFolder, index, request.source);
    const file = chain.files.get(path);
    if (!file) throw new RestoreError(`"${request.path}" is not in backup ${chain.target.id}`);
    await this.assertPartsPresent(backupFolder, [file]);

    const root =
      request.destination.kind === "vault"
        ? ""
        : `${profile.destination.restoreFolder}/${chain.target.id}`;
    const target = destinationPath(root, file.path);
    const current = await store.stat(target);
    if (current && current.type !== "file") {
      throw new RestoreError(`Cannot restore ${target}: a folder is in the way`);
    }

    const data = await readResolvedFile(
      store,
      backupFolder,
      chain,
      file,
      this.deps.deriveMasterKey,
    );
    const result = { writtenTo: target, backupId: file.backupId, bytes: data.length };
    if (!current) {
      await writeAtomic(store, target, data);
      return { ...result, outcome: "created" };
    }
    if (!(await this.differs(target, current.size, file))) {
      return { ...result, outcome: "unchanged" };
    }
    if (!request.overwrite) {
      throw new RestoreError(
        `${target} already exists with different content; overwrite was not chosen`,
      );
    }
    await writeAtomic(store, target, data);
    this.deps.logger.info(`Restored ${file.path} over ${target} from backup ${file.backupId}`);
    return { ...result, outcome: "replaced" };
  }

  private async differs(path: string, currentSize: number, file: ResolvedFile): Promise<boolean> {
    if (currentSize !== file.entry.size) return true;
    return sha256Hex(await this.deps.store.readBinary(path)) !== file.entry.sha256;
  }

  private async assertPartsPresent(backupFolder: string, files: ResolvedFile[]): Promise<void> {
    const checked = new Set<string>();
    for (const f of files) {
      const partPath = `${backupFolder}/${f.folder}/${f.entry.part}`;
      if (checked.has(partPath)) continue;
      checked.add(partPath);
      if (!(await this.deps.store.exists(partPath))) {
        throw new BrokenChainError(`Backup ${f.backupId} is missing ${f.entry.part}`);
      }
    }
  }
}
