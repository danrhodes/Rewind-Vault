import { FILE_NAMES } from "../constants";
import type { ILogger } from "../helpers/logger";
import { writeAtomicText } from "../storage/AtomicWriter";
import { readText, type IVaultStore } from "../storage/VaultStore";

/** Plugin id to installed version. */
export type PluginVersions = Record<string, string>;

export interface PluginChange {
  id: string;
  /** Null for a newly installed plugin. */
  from: string | null;
  to: string;
}

/** Updated or newly installed plugins. Removed plugins are not a risk worth a snapshot. */
export function diffPluginVersions(before: PluginVersions, now: PluginVersions): PluginChange[] {
  const changes: PluginChange[] = [];
  for (const id of Object.keys(now).sort()) {
    const to = now[id] as string;
    const from = before[id] ?? null;
    if (from !== to) changes.push({ id, from, to });
  }
  return changes;
}

export interface PluginWatchDeps {
  store: IVaultStore;
  logger: ILogger;
  /** Vault config folder, normally `.obsidian`. */
  configDir: string;
  backupFolder: () => string;
  /** This plugin's own id: its updates are not a risk to the vault. */
  selfId: string;
}

/** Read every installed plugin's version from `<configDir>/plugins/<id>/manifest.json`. */
export async function readPluginVersions(
  store: IVaultStore,
  configDir: string,
): Promise<PluginVersions> {
  const root = `${configDir}/plugins`;
  const versions: PluginVersions = {};
  if (!(await store.exists(root))) return versions;
  for (const folder of (await store.list(root)).folders) {
    const id = folder.slice(root.length + 1);
    try {
      const manifest = JSON.parse(await readText(store, `${folder}/manifest.json`)) as {
        version?: unknown;
      };
      if (typeof manifest.version === "string") versions[id] = manifest.version;
    } catch {
      // A plugin folder without a readable manifest (half-installed) is simply not listed.
    }
  }
  return versions;
}

/**
 * Notices when other plugins are installed or updated, by comparing their versions with the
 * ones seen last time (kept in `<backupFolder>/plugins.json`). The very first check only
 * records the versions: there is nothing to compare with, so it reports no changes.
 */
export class PluginWatch {
  constructor(private readonly deps: PluginWatchDeps) {}

  private path(): string {
    return `${this.deps.backupFolder()}/${FILE_NAMES.plugins}`;
  }

  async check(): Promise<PluginChange[]> {
    const { store, logger, configDir, selfId } = this.deps;
    const now = await readPluginVersions(store, configDir);
    delete now[selfId];
    let before: PluginVersions | null = null;
    try {
      if (await store.exists(this.path())) {
        before = JSON.parse(await readText(store, this.path())) as PluginVersions;
      }
    } catch {
      before = null; // damaged record: treated as a first run
    }
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      await writeAtomicText(store, this.path(), JSON.stringify(now, null, 2));
    }
    if (before === null) {
      logger.debug("Plugin versions recorded for the first time");
      return [];
    }
    const changes = diffPluginVersions(before, now);
    if (changes.length > 0) {
      logger.info(
        `Plugin changes: ${changes.map((c) => `${c.id} ${c.from ?? "new"} -> ${c.to}`).join(", ")}`,
      );
    }
    return changes;
  }
}
