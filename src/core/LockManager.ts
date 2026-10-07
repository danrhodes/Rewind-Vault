import { FILE_NAMES, SCHEMA_VERSION } from "../constants";
import { LockError } from "../helpers/errors";
import type { IClock } from "../helpers/time";
import { writeAtomicText } from "../storage/AtomicWriter";
import { readText, type IVaultStore } from "../storage/VaultStore";
import type { PlatformKind } from "../types";

export interface LockInfo {
  schemaVersion: number;
  ownerId: string;
  platform: PlatformKind;
  acquiredAt: number;
  /** Updated by `refresh()`. A lock whose heartbeat is older than the timeout is stale. */
  heartbeatAt: number;
}

export interface LockOptions {
  /** Minutes without a heartbeat before a lock counts as abandoned. */
  timeoutMin: number;
  platform: PlatformKind;
  /** Wait between writing the lock and confirming we still own it. */
  settleMs?: number;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const defaultId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseLock(text: string): LockInfo | null {
  try {
    const raw = JSON.parse(text) as Partial<LockInfo> | null;
    if (
      raw &&
      typeof raw.ownerId === "string" &&
      typeof raw.heartbeatAt === "number" &&
      typeof raw.acquiredAt === "number"
    ) {
      return raw as LockInfo;
    }
  } catch {
    // An unreadable lock file is treated as abandoned.
  }
  return null;
}

/**
 * Advisory lock stored in `<backupFolder>/lock.json`. The vault adapter has no exclusive
 * create, so this is best effort: acquire writes the lock, waits briefly, then re-reads to
 * confirm it is still the owner. Two runs that race will end with exactly one winner in
 * practice; across synced devices a rare overlap remains possible, which is why backups
 * are also written atomically and their manifest is saved last.
 */
export class LockManager {
  private readonly ownerId: string;
  private held = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: IVaultStore,
    private readonly backupFolder: string,
    private readonly clock: IClock,
    private readonly options: LockOptions,
  ) {
    this.ownerId = (options.newId ?? defaultId)();
  }

  get path(): string {
    return `${this.backupFolder}/${FILE_NAMES.lock}`;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** Current lock on disk, or null when there is none or it is unreadable. */
  async read(): Promise<LockInfo | null> {
    if (!(await this.store.exists(this.path))) return null;
    return parseLock(await readText(this.store, this.path));
  }

  isStale(lock: LockInfo): boolean {
    return this.clock.now() - lock.heartbeatAt > this.options.timeoutMin * 60_000;
  }

  /** Take the lock or throw LockError if a live run holds it. Calls are serialised. */
  acquire(): Promise<void> {
    return this.serial(async () => {
      if (this.held) throw new LockError("This plugin instance already holds the backup lock");

      const existing = await this.read();
      if (existing && existing.ownerId !== this.ownerId && !this.isStale(existing)) {
        throw new LockError("Another backup is already running");
      }

      await this.write(
        existing && existing.ownerId === this.ownerId ? existing.acquiredAt : this.clock.now(),
      );
      await (this.options.sleep ?? defaultSleep)(this.options.settleMs ?? 50);

      const confirmed = await this.read();
      if (!confirmed || confirmed.ownerId !== this.ownerId) {
        throw new LockError("Another backup started at the same moment and won the lock");
      }
      this.held = true;
    });
  }

  /** Heartbeat. Call between parts so a long backup is not mistaken for a crashed one. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      if (!this.held) throw new LockError("Cannot refresh a lock that is not held");
      const current = await this.read();
      if (!current || current.ownerId !== this.ownerId) {
        this.held = false;
        throw new LockError("The backup lock was taken over by another run");
      }
      await this.write(current.acquiredAt);
    });
  }

  /** Release if we still own it. Safe to call when not held. Never removes someone else's lock. */
  release(): Promise<void> {
    return this.serial(async () => {
      const current = await this.read();
      if (current && current.ownerId === this.ownerId) await this.store.remove(this.path);
      this.held = false;
    });
  }

  private async write(acquiredAt: number): Promise<void> {
    const info: LockInfo = {
      schemaVersion: SCHEMA_VERSION.lock,
      ownerId: this.ownerId,
      platform: this.options.platform,
      acquiredAt,
      heartbeatAt: this.clock.now(),
    };
    await writeAtomicText(this.store, this.path, JSON.stringify(info));
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
