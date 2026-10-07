import type { LogLevel } from "../types";

export interface ILogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LogSink {
  write(line: string): void | Promise<void>;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger implements ILogger {
  constructor(
    private readonly sink: LogSink,
    private level: LogLevel = "info",
    private readonly now: () => number = Date.now,
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string): void {
    this.log("debug", message);
  }

  info(message: string): void {
    this.log("info", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  error(message: string): void {
    this.log("error", message);
  }

  private log(level: LogLevel, message: string): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const line = `${new Date(this.now()).toISOString()} ${level.toUpperCase()} ${message}`;
    // Logging must never throw into the caller.
    void Promise.resolve(this.sink.write(line)).catch(() => undefined);
  }
}

/** Minimal file operations the rotating sink needs. IVaultStore satisfies this. */
export interface LogFileStore {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * Appends lines to `path`. When the file would exceed `maxBytes`, it is moved to
 * `<path>.1` (replacing any older rotation) and a fresh file is started.
 * Writes are serialised so lines never interleave or get lost.
 */
export class RotatingFileSink implements LogSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly store: LogFileStore,
    private readonly path: string,
    private readonly maxBytes: number,
  ) {}

  write(line: string): Promise<void> {
    this.queue = this.queue.then(() => this.append(line)).catch(() => undefined);
    return this.queue;
  }

  private async append(line: string): Promise<void> {
    const entry = this.encoder.encode(`${line}\n`);
    let current: Uint8Array = new Uint8Array(0);
    if (await this.store.exists(this.path)) {
      current = await this.store.readBinary(this.path);
    }
    if (current.length > 0 && current.length + entry.length > this.maxBytes) {
      const rotated = `${this.path}.1`;
      if (await this.store.exists(rotated)) await this.store.remove(rotated);
      await this.store.rename(this.path, rotated);
      current = new Uint8Array(0);
    }
    const next = new Uint8Array(current.length + entry.length);
    next.set(current, 0);
    next.set(entry, current.length);
    await this.store.writeBinary(this.path, next);
  }
}
