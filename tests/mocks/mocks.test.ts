import { describe, expect, it } from "vitest";
import { MockClock } from "./MockClock";
import { MockLogger } from "./MockLogger";
import { MockVaultStore } from "./MockVaultStore";

describe("mock layer", () => {
  it("MockVaultStore round-trips files and stamps mtime from MockClock", async () => {
    const clock = new MockClock(1000);
    const store = new MockVaultStore(clock);
    await store.seed("notes/a.md", "hello");
    clock.advance(500);
    await store.writeBinary("notes/b.md", new Uint8Array([1, 2, 3]));

    expect(new TextDecoder().decode(await store.readBinary("notes/a.md"))).toBe("hello");
    expect(await store.stat("notes/a.md")).toEqual({ type: "file", size: 5, mtime: 1000 });
    expect((await store.stat("notes/b.md"))?.mtime).toBe(1500);
    expect(await store.list("notes")).toEqual({ files: ["notes/a.md", "notes/b.md"], folders: [] });
    expect((await store.list("")).folders).toEqual(["notes"]);

    await store.rename("notes/a.md", "archive/a.md");
    expect(await store.exists("notes/a.md")).toBe(false);
    await store.remove("archive/a.md");
    await expect(store.readBinary("archive/a.md")).rejects.toThrow("ENOENT");
  });

  it("MockLogger captures entries by level", () => {
    const log = new MockLogger();
    log.info("a");
    log.error("b");
    expect(log.messages()).toEqual(["a", "b"]);
    expect(log.messages("error")).toEqual(["b"]);
  });
});
