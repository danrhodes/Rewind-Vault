import { diffVault } from "../core/Differ";
import { loadState } from "../core/BackupState";
import { scanOptionsFromProfile, scanVault } from "../core/Scanner";
import type { ILogger } from "../helpers/logger";
import type { INetworkProbe } from "../helpers/network";
import type { IPlatform } from "../helpers/platform";
import { createYielder } from "../helpers/yieldToUI";
import { checkFreeSpace, type IFreeSpaceProbe } from "../storage/FreeSpace";
import type { IVaultStore } from "../storage/VaultStore";
import type { SettingsProfile } from "../types";

export type ConditionId = "battery" | "wifi" | "free-space" | "no-changes";

export interface BlockedCondition {
  condition: ConditionId;
  message: string;
}

export interface ConditionResult {
  /** True when a triggered backup may go ahead. */
  ok: boolean;
  blocked: BlockedCondition[];
  /** Conditions that could not be evaluated on this platform and therefore did not block. */
  unknown: ConditionId[];
}

export interface ConditionDeps {
  store: IVaultStore;
  logger: ILogger;
  platform: IPlatform;
  getProfile: () => SettingsProfile;
  freeSpace?: IFreeSpaceProbe;
  network?: INetworkProbe;
  yieldIfNeeded?: () => Promise<void>;
  /** Skip the minimum-battery check (the low-battery flush runs precisely because it is low). */
  ignoreBattery?: boolean;
}

/**
 * Decide whether an AUTOMATIC backup may run now: enough battery (or charging), on Wi-Fi when
 * asked, enough free space, and something actually changed. Manual "Backup now" should skip
 * this. A condition the platform cannot measure never blocks (it is listed in `unknown`), so a
 * missing API can never stop backups for good. Cheap checks run first; the change check scans
 * the vault, so it runs only when everything else already allows the backup.
 */
export async function evaluateConditions(deps: ConditionDeps): Promise<ConditionResult> {
  const { conditions } = deps.getProfile();
  const blocked: BlockedCondition[] = [];
  const unknown: ConditionId[] = [];

  if (conditions.minBatteryPct > 0 && !deps.ignoreBattery) {
    const battery = await deps.platform.getBattery();
    if (!battery) unknown.push("battery");
    else if (!battery.charging && battery.level < conditions.minBatteryPct) {
      blocked.push({
        condition: "battery",
        message: `Battery at ${battery.level}%, below the ${conditions.minBatteryPct}% minimum`,
      });
    }
  }

  if (conditions.wifiOnly) {
    const unmetered = deps.network?.isUnmetered() ?? null;
    if (unmetered === null) unknown.push("wifi");
    else if (!unmetered) blocked.push({ condition: "wifi", message: "Not on Wi-Fi" });
  }

  if (conditions.minFreeSpaceMb > 0 && deps.freeSpace) {
    const space = await checkFreeSpace(deps.freeSpace, 0, conditions.minFreeSpaceMb);
    if (!space.known) unknown.push("free-space");
    else if (!space.ok) {
      blocked.push({
        condition: "free-space",
        message: `Free space below the ${conditions.minFreeSpaceMb} MB minimum`,
      });
    }
  }

  if (blocked.length === 0 && conditions.skipIfNoChanges && !(await hasChanges(deps))) {
    blocked.push({ condition: "no-changes", message: "Nothing changed since the last backup" });
  }

  const result = { ok: blocked.length === 0, blocked, unknown };
  if (!result.ok) {
    deps.logger.info(`Automatic backup held back: ${blocked.map((b) => b.message).join("; ")}`);
  }
  return result;
}

/**
 * True when the vault differs from what the last backup saw, or when that cannot be told
 * (no history yet, unreadable state): in doubt a backup is allowed.
 */
export async function hasChanges(
  deps: Pick<ConditionDeps, "store" | "getProfile" | "logger" | "yieldIfNeeded">,
): Promise<boolean> {
  const profile = deps.getProfile();
  let state;
  try {
    state = await loadState(deps.store, profile.destination.backupFolder);
  } catch (error) {
    deps.logger.debug(`Change check skipped, state unreadable: ${String(error)}`);
    return true;
  }
  if (state.updatedAt === 0) return true;
  const yieldIfNeeded = deps.yieldIfNeeded ?? createYielder();
  const files = await scanVault(deps.store, scanOptionsFromProfile(profile), yieldIfNeeded);
  const diff = await diffVault(deps.store, files, state, yieldIfNeeded);
  return diff.added.length + diff.changed.length + diff.deleted.length > 0;
}
