import { StorageError } from "../helpers/errors";
import type { ILogger } from "../helpers/logger";
import type { IVaultStore } from "./VaultStore";

/**
 * The slice of Node's `fs.promises` this file uses. This is the ONLY place in the plugin that
 * touches Node (PLAN section 3): it exists on desktop Obsidian (Electron) and not on mobile.
 */
export interface ExternalFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  unlink(path: string): Promise<void>;
}

/**
 * Node's `fs.promises`, or null where there is none (mobile). Loaded through the runtime's
 * global `require` instead of an import, so the mobile bundle contains no reference to `fs`.
 */
export function loadNodeFs(): ExternalFs | null {
  const load = (globalThis as { require?: (id: string) => unknown }).require;
  if (typeof load !== "function") return null;
  try {
    const fs = load("fs") as { promises?: ExternalFs };
    return fs.promises ?? null;
  } catch {
    return null;
  }
}

/** An absolute path on this machine: `/home/x`, `C:\x`, `C:/x` or `\\server\share`. No `..`. */
export function isValidExternalPath(path: string): boolean {
  const p = path.trim();
  if (p === "" || p.includes("\0")) return false;
  const absolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);
  return absolute && !p.split(/[\\/]+/).includes("..");
}

export interface ExternalCopyResult {
  files: number;
  bytes: number;
  /** Where the backup folder was written. */
  destination: string;
}

const join = (root: string, ...parts: string[]): string =>
  [root.replace(/[\\/]+$/, ""), ...parts].join("/");

/** Backups reach the external folder in this order: parts first, manifest last. */
const MANIFEST = "manifest.json";

/**
 * Copies a finished backup folder to a folder outside the vault (desktop). Every file is
 * written under a temporary name, size-checked, then renamed, and the manifest goes LAST, so
 * an interrupted copy never looks like a complete backup. Existing files are replaced. The
 * copy is a plain mirror: nothing in the external folder is ever deleted by the plugin.
 */
export class ExternalCopy {
  constructor(
    private readonly store: IVaultStore,
    private readonly fs: ExternalFs,
    private readonly logger: ILogger,
  ) {}

  async copyBackup(
    backupFolder: string,
    folderName: string,
    externalRoot: string,
  ): Promise<ExternalCopyResult> {
    if (!isValidExternalPath(externalRoot)) {
      throw new StorageError(externalRoot, "The external copy path is not an absolute folder path");
    }
    const source = `${backupFolder}/${folderName}`;
    const target = join(externalRoot.trim(), folderName);
    const names = (await this.store.list(source)).files
      .map((path) => path.slice(source.length + 1))
      .sort((a, b) => Number(a === MANIFEST) - Number(b === MANIFEST) || a.localeCompare(b));
    if (!names.includes(MANIFEST)) {
      throw new StorageError(source, "Cannot copy a backup without a manifest");
    }
    await this.fs.mkdir(target, { recursive: true });

    let bytes = 0;
    for (const name of names) {
      const data = await this.store.readBinary(`${source}/${name}`);
      const final = join(target, name);
      const temp = `${final}.tmp`;
      try {
        await this.fs.writeFile(temp, data);
        const written = await this.fs.stat(temp);
        if (written.size !== data.length) {
          throw new Error(`wrote ${written.size} of ${data.length} bytes`);
        }
        await this.fs.rename(temp, final);
      } catch (cause) {
        await this.fs.unlink(temp).catch(() => undefined);
        throw new StorageError(final, "Cannot write", { cause });
      }
      bytes += data.length;
    }
    this.logger.info(`External copy of ${folderName}: ${names.length} file(s) to ${target}`);
    return { files: names.length, bytes, destination: target };
  }
}
