import { applyLowMemory } from "../helpers/memoryBudget";
import type { IPlatform } from "../helpers/platform";
import type { PlatformKind, Settings, SettingsProfile } from "../types";

function cloneProfile(profile: SettingsProfile): SettingsProfile {
  return JSON.parse(JSON.stringify(profile)) as SettingsProfile;
}

/**
 * The profile to use on this platform, as a copy. Desktop-only features are forced off
 * on mobile even if a synced or imported settings file has them on (PLAN §2).
 */
export function resolveProfile(settings: Settings, kind: PlatformKind): SettingsProfile {
  const profile = cloneProfile(settings[kind]);
  if (kind === "mobile") {
    profile.destination.destination = "vault";
    profile.triggers.onClose = false;
    profile.notifications.statusBar = false;
  }
  return applyLowMemory(profile);
}

export function resolveProfileFor(settings: Settings, platform: IPlatform): SettingsProfile {
  return resolveProfile(settings, platform.kind);
}
