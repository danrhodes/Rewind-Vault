import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadState } from "../../src/core/BackupState";
import { enc, rig, runOk, seedVault } from "../support/engineRig";

const SECOND = 1000;

describe("skip when nothing changed", () => {
  it("a differential run with no changes creates no backup and touches nothing", async () => {
    const r = rig();
    await seedVault(r.store, 10);
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(60 * SECOND);

    const result = await r.engine.run({ mode: "diff" });
    expect(result).toEqual({ status: "skipped", reason: "no-changes" });
    expect((await loadIndex(r.store, "backup")).backups).toHaveLength(1);
    expect((await r.store.list("backup")).folders).toHaveLength(1);
    expect(await r.store.exists("backup/lock.json")).toBe(false);
    expect(await r.store.exists("backup/checkpoint.json")).toBe(false);
    expect(r.logger.messages("info").join()).toContain("skipped");
  });

  it("with the setting off, an empty differential backup is still made", async () => {
    const r = rig((p) => void (p.conditions.skipIfNoChanges = false));
    await seedVault(r.store, 3);
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(60 * SECOND);
    const result = await runOk(r.engine, { mode: "diff" });
    expect(result).toMatchObject({ type: "diff", fileCount: 0 });
    expect((await loadIndex(r.store, "backup")).backups).toHaveLength(2);
  });

  it("any real change defeats the skip: edit, add or delete", async () => {
    for (const change of ["edit", "add", "delete"] as const) {
      const r = rig();
      await r.store.seed("a.md", "1");
      await r.store.seed("b.md", "1");
      await runOk(r.engine, { mode: "full" });
      r.clock.advance(60 * SECOND);
      if (change === "edit") await r.store.writeBinary("a.md", enc("22"));
      if (change === "add") await r.store.seed("c.md", "1");
      if (change === "delete") await r.store.remove("b.md");
      const result = await r.engine.run({ mode: "diff" });
      expect(result.status, change).toBe("completed");
    }
  });

  it("full runs are never skipped, and neither is the first run", async () => {
    const r = rig();
    await r.store.seed("a.md", "1");
    const first = await r.engine.run({ mode: "diff" }); // no history: becomes full
    expect(first).toMatchObject({ status: "completed", type: "full" });
    r.clock.advance(60 * SECOND);
    expect((await r.engine.run({ mode: "full" })).status).toBe("completed");
  });

  it("an empty vault after a full backup is also skipped", async () => {
    const r = rig();
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(60 * SECOND);
    expect((await r.engine.run({ mode: "diff" })).status).toBe("skipped");
  });

  it("timestamp-only changes are skipped but remembered, so they are not re-hashed next time", async () => {
    const r = rig();
    await seedVault(r.store, 6);
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(60 * SECOND);
    for (const path of ["folder0/sub0/note-0.md", "folder1/sub1/note-1.md"]) {
      await r.store.writeBinary(path, await r.store.readBinary(path)); // same bytes, new mtime
    }

    const reads: string[] = [];
    const read = r.store.readBinary.bind(r.store);
    r.store.readBinary = async (p) => (reads.push(p), read(p));

    expect((await r.engine.run({ mode: "diff" })).status).toBe("skipped");
    const vaultReads = (): string[] => reads.filter((p) => !p.startsWith("backup/")).sort();
    expect(vaultReads()).toEqual(["folder0/sub0/note-0.md", "folder1/sub1/note-1.md"]);
    const state = await loadState(r.store, "backup");
    expect(state.files["folder0/sub0/note-0.md"]!.mtime).toBe(r.clock.now());

    reads.length = 0;
    expect((await r.engine.run({ mode: "diff" })).status).toBe("skipped");
    expect(vaultReads()).toEqual([]); // nothing re-hashed
  });

  it("works for non-destructive runs too", async () => {
    const r = rig();
    await seedVault(r.store, 4);
    await runOk(r.engine, { mode: "full", nonDestructive: true });
    r.clock.advance(60 * SECOND);
    expect((await r.engine.run({ mode: "diff", nonDestructive: true })).status).toBe("skipped");
    expect((await r.store.list("backup")).folders).toHaveLength(1);
  });
});
