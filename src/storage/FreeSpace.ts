import { InsufficientSpaceError } from "../helpers/errors";

/** Reports free bytes, or null when the platform cannot tell. */
export interface IFreeSpaceProbe {
  getFreeBytes(): Promise<number | null>;
}

interface StorageManagerLike {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}

/**
 * Probe backed by `navigator.storage.estimate()`. This is a browser-quota estimate,
 * not true disk space, so treat it as a hint. Returns null where it is unsupported.
 */
export function createStorageEstimateProbe(storage?: StorageManagerLike): IFreeSpaceProbe {
  const manager = storage ?? (typeof navigator === "undefined" ? undefined : navigator.storage);
  return {
    async getFreeBytes() {
      if (!manager) return null;
      try {
        const { quota, usage } = await manager.estimate();
        if (typeof quota !== "number" || typeof usage !== "number") return null;
        return Math.max(0, quota - usage);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Rough size of the backup output. Level 0 stores files as-is; otherwise assume
 * text-heavy vaults compress to about 60%. Deliberately pessimistic for a precheck.
 */
export function estimateBackupBytes(
  files: readonly { size: number }[],
  compressionLevel: number,
): number {
  const source = files.reduce((sum, f) => sum + f.size, 0);
  return Math.ceil(compressionLevel === 0 ? source : source * 0.6);
}

export interface SpaceCheck {
  ok: boolean;
  /** False when the platform could not report free space. */
  known: boolean;
  freeBytes: number | null;
  requiredBytes: number;
}

/**
 * Passes when free space is at least `requiredBytes` plus the `minFreeMb` reserve.
 * If free space is unknown the check passes (`known: false`) rather than blocking backups.
 */
export async function checkFreeSpace(
  probe: IFreeSpaceProbe,
  requiredBytes: number,
  minFreeMb: number,
): Promise<SpaceCheck> {
  const freeBytes = await probe.getFreeBytes();
  if (freeBytes === null) return { ok: true, known: false, freeBytes, requiredBytes };
  const needed = requiredBytes + minFreeMb * 1024 * 1024;
  return { ok: freeBytes >= needed, known: true, freeBytes, requiredBytes };
}

export async function assertFreeSpace(
  probe: IFreeSpaceProbe,
  requiredBytes: number,
  minFreeMb: number,
): Promise<SpaceCheck> {
  const result = await checkFreeSpace(probe, requiredBytes, minFreeMb);
  if (!result.ok && result.freeBytes !== null) {
    throw new InsufficientSpaceError(requiredBytes + minFreeMb * 1024 * 1024, result.freeBytes);
  }
  return result;
}
