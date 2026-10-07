import type { ILogger } from "../helpers/logger";
import type { IClock } from "../helpers/time";
import type { SettingsProfile } from "../types";

/** Why a backup was requested. Passed to the callback every trigger shares. */
export type TriggerReason =
  | "startup"
  | "resume"
  | "interval"
  | "daily"
  | "edits"
  | "idle"
  | "create"
  | "delete"
  | "rename"
  | "close";

/**
 * What a trigger calls when it decides a backup is due. The caller (wired in main/services)
 * owns de-duplication and conditions, then calls BackupEngine. Triggers never import it.
 */
export type RunRequest = (reason: TriggerReason) => Promise<void>;

/**
 * Repeating timers, supplied by the host. In the plugin this wraps
 * `plugin.registerInterval(window.setInterval(...))` so Obsidian clears them on unload;
 * tests use fake timers.
 */
export interface TimerHost {
  setInterval(callback: () => void, ms: number): number;
  clearInterval(handle: number): void;
  /** One-shot timer, for delays. */
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export const globalTimerHost: TimerHost = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms) as unknown as number,
  clearInterval: (handle) => globalThis.clearInterval(handle),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface TriggerDeps {
  clock: IClock;
  logger: ILogger;
  getProfile: () => SettingsProfile;
  run: RunRequest;
}
