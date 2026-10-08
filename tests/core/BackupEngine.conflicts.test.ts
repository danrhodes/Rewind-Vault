import { describe, expect, it } from "vitest";
import { rig, runOk } from "../support/engineRig";

describe("sync-conflict files", () => {
  it("are reported in the result and the log, and still backed up", async () => {
    const r = rig();
    await r.store.seed("Note.md", "mine");
    await r.store.seed("Note (conflicted copy 2026-10-08).md", "theirs");
    await r.store.seed("Other.sync-conflict-20261008-101500-ABCDEFG.md", "x");
    const result = await runOk(r.engine, { mode: "full" });
    expect(result.fileCount).toBe(3);
    expect(result.conflictFiles).toEqual([
      {
        path: "Note (conflicted copy 2026-10-08).md",
        original: "Note.md",
        originalExists: true,
      },
      {
        path: "Other.sync-conflict-20261008-101500-ABCDEFG.md",
        original: "Other.md",
        originalExists: false,
      },
    ]);
    expect(r.logger.messages("warn").join()).toContain("2 sync-conflict file(s)");
  });

  it("are absent from the result when the vault has none", async () => {
    const r = rig();
    await r.store.seed("a.md", "a");
    const result = await runOk(r.engine, { mode: "full" });
    expect("conflictFiles" in result).toBe(false);
  });

  it("still count in a differential run that has nothing else to back up", async () => {
    const r = rig((p) => void (p.conditions.skipIfNoChanges = false));
    await r.store.seed("a.md", "a");
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(60_000);
    await r.store.seed("a (conflicted copy 1).md", "b");
    const result = await runOk(r.engine, { mode: "diff" });
    expect(result.conflictFiles).toHaveLength(1);
  });
});
