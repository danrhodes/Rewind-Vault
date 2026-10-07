import { describe, expect, it } from "vitest";
import { Logger, RotatingFileSink, type LogSink } from "../../src/helpers/logger";
import { MockVaultStore } from "../mocks/MockVaultStore";

const text = async (s: MockVaultStore, p: string): Promise<string> =>
  new TextDecoder().decode(await s.readBinary(p));

describe("Logger", () => {
  it("filters below the configured level and stamps ISO time", () => {
    const lines: string[] = [];
    const sink: LogSink = { write: (l) => void lines.push(l) };
    const log = new Logger(sink, "warn", () => Date.UTC(2026, 9, 7, 12, 0, 0));
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toEqual(["2026-10-07T12:00:00.000Z WARN w", "2026-10-07T12:00:00.000Z ERROR e"]);
    log.setLevel("debug");
    log.debug("now visible");
    expect(lines).toHaveLength(3);
  });

  it("swallows sink failures", async () => {
    const sink: LogSink = { write: () => Promise.reject(new Error("disk full")) };
    const log = new Logger(sink);
    expect(() => log.error("x")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("RotatingFileSink", () => {
  it("appends lines in order, even when written concurrently", async () => {
    const store = new MockVaultStore();
    const sink = new RotatingFileSink(store, "backup/log.txt", 10_000);
    await Promise.all(["a", "b", "c"].map((l) => sink.write(l)));
    expect(await text(store, "backup/log.txt")).toBe("a\nb\nc\n");
  });

  it("rotates to .1 when the cap is exceeded and drops older rotations", async () => {
    const store = new MockVaultStore();
    const sink = new RotatingFileSink(store, "log.txt", 20);
    for (const l of ["aaaaaaaaa", "bbbbbbbbb", "ccccccccc", "ddddddddd"]) await sink.write(l);
    // Each entry is 10 bytes; cap 20 holds two.
    expect(await text(store, "log.txt")).toBe("ccccccccc\nddddddddd\n");
    expect(await text(store, "log.txt.1")).toBe("aaaaaaaaa\nbbbbbbbbb\n");
    for (const l of ["eeeeeeeee", "fffffffff"]) await sink.write(l);
    expect(await text(store, "log.txt.1")).toBe("ccccccccc\nddddddddd\n");
    expect((await store.stat("log.txt"))!.size).toBeLessThanOrEqual(20);
  });

  it("keeps an oversized single line rather than looping", async () => {
    const store = new MockVaultStore();
    const sink = new RotatingFileSink(store, "log.txt", 5);
    await sink.write("this line is longer than the cap");
    expect(await text(store, "log.txt")).toContain("longer than the cap");
  });
});
