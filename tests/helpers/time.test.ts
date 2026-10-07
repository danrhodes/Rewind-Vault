import { describe, expect, it } from "vitest";
import {
  backupFolderName,
  folderTimestamp,
  parseBackupFolderName,
  parseFolderTimestamp,
  parseTimeOfDay,
  systemClock,
} from "../../src/helpers/time";
import { formatBytes, formatDuration } from "../../src/helpers/format";

const T = Date.UTC(2026, 9, 7, 21, 24, 0);

describe("time", () => {
  it("formats and parses folder timestamps", () => {
    expect(folderTimestamp(T)).toBe("2026-10-07T21-24-00");
    expect(parseFolderTimestamp("2026-10-07T21-24-00")).toBe(T);
    expect(parseFolderTimestamp("2026-13-07T21-24-00")).toBeNull();
    expect(parseFolderTimestamp("2026-02-30T00-00-00")).toBeNull();
    expect(parseFolderTimestamp("nonsense")).toBeNull();
  });

  it("timestamps sort chronologically as strings", () => {
    const a = folderTimestamp(T);
    const b = folderTimestamp(T + 1000);
    const c = folderTimestamp(T + 86_400_000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it("builds and parses backup folder names", () => {
    expect(backupFolderName(T, "full")).toBe("2026-10-07T21-24-00_full");
    expect(backupFolderName(T, "diff")).toBe("2026-10-07T21-24-00_diff");
    expect(parseBackupFolderName("2026-10-07T21-24-00_diff")).toEqual({
      createdAt: T,
      type: "diff",
    });
    expect(parseBackupFolderName("2026-10-07T21-24-00_other")).toBeNull();
    expect(parseBackupFolderName("index.json")).toBeNull();
  });

  it("parses time of day", () => {
    expect(parseTimeOfDay("09:30")).toBe(570);
    expect(parseTimeOfDay("9:05")).toBe(545);
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("12:60")).toBeNull();
    expect(parseTimeOfDay("abc")).toBeNull();
  });

  it("systemClock returns current time", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });
});

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });

  it("formats durations", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_700_000)).toBe("1h 1m");
    expect(formatDuration(-5)).toBe("0 ms");
  });
});
