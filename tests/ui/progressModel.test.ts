import { describe, expect, it, vi } from "vitest";
import type { RestoreProgress } from "../../src/core/RestoreTypes";
import type { RunProgress } from "../../src/core/RunTypes";
import {
  CancelSource,
  RenderThrottle,
  viewBackupProgress,
  viewRestoreProgress,
} from "../../src/ui/progressModel";

const run = (extra: Partial<RunProgress> = {}): RunProgress => ({
  phase: "packing",
  partIndex: 1,
  partCount: 1,
  filesDone: 12,
  filesTotal: 340,
  bytesDone: 1_258_291,
  bytesTotal: 8_388_608,
  ...extra,
});

const restore = (extra: Partial<RestoreProgress> = {}): RestoreProgress => ({
  phase: "writing",
  filesDone: 2,
  filesTotal: 4,
  bytesDone: 50,
  bytesTotal: 200,
  ...extra,
});

describe("viewBackupProgress", () => {
  it("packing shows files, bytes, fraction by bytes and the current file", () => {
    const v = viewBackupProgress(run({ currentFile: "notes/a.md" }));
    expect(v.heading).toBe("Backing up");
    expect(v.detail).toBe("12 of 340 files, 1.2 MB of 8 MB");
    expect(v.fraction).toBeCloseTo(0.15, 2);
    expect(v.currentFile).toBe("notes/a.md");
  });

  it("names the part when the backup is split", () => {
    expect(viewBackupProgress(run({ partIndex: 2, partCount: 3 })).heading).toBe(
      "Backing up (part 2 of 3)",
    );
  });

  it("falls back to files when bytes are unknown, and to indeterminate when nothing is", () => {
    expect(viewBackupProgress(run({ bytesTotal: 0 })).fraction).toBeCloseTo(12 / 340, 5);
    expect(viewBackupProgress(run({ bytesTotal: 0, filesTotal: 0 })).fraction).toBeNull();
  });

  it("clamps the fraction to 0..1", () => {
    expect(viewBackupProgress(run({ bytesDone: 99_999_999 })).fraction).toBe(1);
    expect(viewBackupProgress(run({ bytesDone: -5 })).fraction).toBe(0);
  });

  it("singular file wording", () => {
    expect(viewBackupProgress(run({ filesTotal: 1, filesDone: 0, bytesTotal: 0 })).detail).toBe(
      "0 of 1 file",
    );
  });

  it("scanning and verifying are indeterminate, finalizing is full", () => {
    expect(viewBackupProgress(run({ phase: "scanning" })).fraction).toBeNull();
    expect(viewBackupProgress(run({ phase: "verifying" })).heading).toContain("Verifying");
    expect(viewBackupProgress(run({ phase: "finalizing" })).fraction).toBe(1);
  });

  it("omits currentFile when there is none", () => {
    expect("currentFile" in viewBackupProgress(run())).toBe(false);
  });
});

describe("viewRestoreProgress", () => {
  it("snapshot phase is indeterminate and says why", () => {
    const v = viewRestoreProgress(restore({ phase: "snapshot" }));
    expect(v.heading).toContain("safety snapshot");
    expect(v.fraction).toBeNull();
  });

  it("writing uses bytes; deleting uses file counts", () => {
    expect(viewRestoreProgress(restore()).fraction).toBe(0.25);
    const del = viewRestoreProgress(restore({ phase: "deleting" }));
    expect(del.heading).toBe("Removing extra files");
    expect(del.fraction).toBe(0.5);
  });

  it("shows the current file", () => {
    expect(viewRestoreProgress(restore({ currentFile: "x.md" })).currentFile).toBe("x.md");
  });
});

describe("CancelSource", () => {
  it("starts not cancelled and stays cancelled", () => {
    const c = new CancelSource();
    expect(c.isCancelled()).toBe(false);
    c.cancel();
    c.cancel();
    expect(c.isCancelled()).toBe(true);
  });

  it("isCancelled can be handed to an engine as a bare function", () => {
    const c = new CancelSource();
    const poll = c.isCancelled;
    c.cancel();
    expect(poll()).toBe(true);
  });

  it("notifies listeners once, and unsubscribe works", () => {
    const c = new CancelSource();
    const a = vi.fn();
    const b = vi.fn();
    c.onCancel(a);
    c.onCancel(b)();
    c.cancel();
    c.cancel();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});

describe("RenderThrottle", () => {
  it("always renders the first call, then at most once per interval", () => {
    let now = 1000;
    const t = new RenderThrottle(() => now, 100);
    expect(t.shouldRender()).toBe(true);
    now += 50;
    expect(t.shouldRender()).toBe(false);
    now += 50;
    expect(t.shouldRender()).toBe(true);
    now += 99;
    expect(t.shouldRender()).toBe(false);
  });

  it("reset forces the next render", () => {
    const now = 0;
    const t = new RenderThrottle(() => now, 100);
    t.shouldRender();
    t.reset();
    expect(t.shouldRender()).toBe(true);
  });
});
