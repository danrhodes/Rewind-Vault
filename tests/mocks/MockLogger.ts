export type MockLogLevel = "debug" | "info" | "warn" | "error";

export interface MockLogEntry {
  level: MockLogLevel;
  message: string;
}

/** Captures log lines in memory so tests can assert on them. */
export class MockLogger {
  readonly entries: MockLogEntry[] = [];

  debug(message: string): void {
    this.entries.push({ level: "debug", message });
  }

  info(message: string): void {
    this.entries.push({ level: "info", message });
  }

  warn(message: string): void {
    this.entries.push({ level: "warn", message });
  }

  error(message: string): void {
    this.entries.push({ level: "error", message });
  }

  messages(level?: MockLogLevel): string[] {
    return this.entries.filter((e) => !level || e.level === level).map((e) => e.message);
  }
}
