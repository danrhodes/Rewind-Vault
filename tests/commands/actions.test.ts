import { describe, expect, it, vi } from "vitest";
import { Actions, type ProgressHandle } from "../../src/commands/actions";
import { loadIndex } from "../../src/core/BackupIndex";
import { verifyAndRecord } from "../../src/core/VerifyRunner";
import { InsufficientSpaceError, LockError } from "../../src/helpers/errors";
import type { RunProgress } from "../../src/core/RunTypes";
import { Notifier } from "../../src/ui/notify";
import type { CancelSource } from "../../src/ui/progressModel";
import type { VerifyReport } from "../../src/types";
import { enc, fastMaster, rig, type Rig } from "../support/engineRig";

interface Harness {
  r: Rig;
  actions: Actions;
  notices: string[];
  opened: { title: string; cancel: CancelSource; updates: RunProgress[]; closed: boolean }[];
  reports: VerifyReport[];
}

function harness(
  tweak: (r: Rig) => void = () => undefined,
  level: "verbose" | "errors" = "verbose",
) {
  const r = rig((p) => {
    p.notifications.level = level;
  });
  tweak(r);
  const notices: string[] = [];
  const opened: Harness["opened"] = [];
  const reports: VerifyReport[] = [];
  const getProfile = () => r.profile;
  const actions = new Actions({
    store: r.store,
    logger: r.logger,
    backup: r.engine,
    verifyBackup: (id, options) =>
      verifyAndRecord(
        {
          store: r.store,
          logger: r.logger,
          clock: r.clock,
          getProfile,
          platform: "desktop",
          deriveMasterKey: fastMaster,
          lockOptions: { sleep: async () => undefined },
        },
        id,
        options,
      ),
    notifier: new Notifier((m) => notices.push(m), getProfile),
    getProfile,
    progress: {
      open(title, cancel) {
        const record = { title, cancel, updates: [] as RunProgress[], closed: false };
        opened.push(record);
        const handle: ProgressHandle = {
          updateBackup: (p) => record.updates.push(p),
          close: () => {
            record.closed = true;
          },
        };
        return handle;
      },
    },
    results: { showVerifyReport: (rep) => reports.push(rep) },
  });
  return { r, actions, notices, opened, reports } as Harness;
}

async function seed(r: Rig): Promise<void> {
  await r.store.seed("a.md", "alpha");
  await r.store.seed("b.md", "beta");
}

const joined = (h: Harness): string => h.notices.join(" | ");

describe("backup commands", () => {
  it("back up now makes a backup, shows progress, and reports success", async () => {
    const h = harness();
    await seed(h.r);
    await h.actions.backupNow();
    const index = await loadIndex(h.r.store, "backup");
    expect(index.backups).toHaveLength(1);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.title).toBe("Backing up");
    expect(h.opened[0]?.updates.length).toBeGreaterThan(0);
    expect(h.opened[0]?.closed).toBe(true);
    expect(joined(h)).toContain("Backup complete: 2 files");
    expect(h.actions.isBusy).toBe(false);
  });

  it("uses the configured automatic style, and differential when that is off", async () => {
    const full = harness((r) => {
      r.profile.basic.autoStyle = "full";
    });
    await seed(full.r);
    await full.actions.backupNow();
    await full.actions.backupNow();
    const types = (await loadIndex(full.r.store, "backup")).backups.map((b) => b.type);
    expect(types).toEqual(["full", "full"]);

    const off = harness((r) => {
      r.profile.basic.autoStyle = "off";
      r.profile.conditions.skipIfNoChanges = false;
    });
    await seed(off.r);
    await off.actions.backupNow(); // first run is always full
    off.r.clock.advance(60_000);
    await off.r.store.writeBinary("a.md", enc("changed"));
    await off.actions.backupNow();
    expect((await loadIndex(off.r.store, "backup")).backups.map((b) => b.type).sort()).toEqual([
      "diff",
      "full",
    ]);
  });

  it("full, differential and non-destructive commands pass their options to the engine", async () => {
    const h = harness();
    await seed(h.r);
    const run = vi.spyOn(h.r.engine, "run");
    await h.actions.backupFull();
    await h.actions.backupDifferential();
    await h.actions.backupNonDestructive();
    expect(run.mock.calls.map(([o]) => [o.mode, o.nonDestructive ?? false])).toEqual([
      ["full", false],
      ["diff", false],
      ["diff", true],
    ]);
  });

  it("a run with no changes says so", async () => {
    const h = harness();
    await seed(h.r);
    await h.actions.backupNow();
    h.notices.length = 0;
    await h.actions.backupNow();
    expect(joined(h)).toContain("No changes");
  });

  it("cancelling stops the run, leaves no backup, and says it was cancelled", async () => {
    const h = harness();
    await seed(h.r);
    const original = h.r.engine.run.bind(h.r.engine);
    vi.spyOn(h.r.engine, "run").mockImplementation((options) => {
      h.opened[0]?.cancel.cancel(); // the user presses Cancel as soon as the dialog is up
      return original(options);
    });
    await h.actions.backupNow();
    expect((await loadIndex(h.r.store, "backup")).backups).toHaveLength(0);
    expect(joined(h)).toContain("Backup cancelled");
    expect(h.opened[0]?.closed).toBe(true);
    expect(h.actions.isBusy).toBe(false);
  });

  it("a second request while one is running is refused, not queued", async () => {
    const h = harness();
    await seed(h.r);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.r.engine.run.bind(h.r.engine);
    vi.spyOn(h.r.engine, "run").mockImplementationOnce(async (options) => {
      await gate;
      return original(options);
    });
    const first = h.actions.backupNow();
    expect(h.actions.isBusy).toBe(true);
    await h.actions.backupFull();
    expect(joined(h)).toContain("already running");
    expect(h.opened).toHaveLength(1);
    release();
    await first;
    expect((await loadIndex(h.r.store, "backup")).backups).toHaveLength(1);
  });

  it("failures end in a notice and a log line, and free the busy flag", async () => {
    const h = harness();
    vi.spyOn(h.r.engine, "run").mockRejectedValue(new Error("disk exploded"));
    await h.actions.backupNow();
    expect(joined(h)).toContain("Backup failed: disk exploded");
    expect(h.r.logger.messages("error").join(" ")).toContain("disk exploded");
    expect(h.actions.isBusy).toBe(false);
    expect(h.opened[0]?.closed).toBe(true);
  });

  it("a held lock and a full disk get friendly messages", async () => {
    const h = harness();
    const run = vi.spyOn(h.r.engine, "run");
    run.mockRejectedValueOnce(new LockError("Another backup is running"));
    await h.actions.backupNow();
    expect(joined(h)).toContain("did not start: Another backup is running");
    run.mockRejectedValueOnce(new InsufficientSpaceError(10, 1));
    await h.actions.backupNow();
    expect(joined(h)).toContain("not enough free space");
  });

  it("notices respect the level: errors-only shows failures but not success", async () => {
    const h = harness(() => undefined, "errors");
    await seed(h.r);
    await h.actions.backupNow();
    expect(h.notices).toEqual([]);
    vi.spyOn(h.r.engine, "run").mockRejectedValue(new Error("boom"));
    await h.actions.backupNow();
    expect(h.notices).toHaveLength(1);
  });
});

describe("resume command", () => {
  it("says so when nothing was interrupted", async () => {
    const h = harness();
    await h.actions.resumeInterrupted();
    expect(joined(h)).toContain("no interrupted backup");
    expect(h.opened).toHaveLength(0);
  });

  it("resumes with the interrupted backup's type and its own dialog title", async () => {
    const h = harness();
    vi.spyOn(h.r.engine, "findResumable").mockResolvedValue({
      backupId: "x",
      type: "full",
      partsDone: 1,
      partsTotal: 2,
      savedAt: 0,
    });
    const resume = vi
      .spyOn(h.r.engine, "resume")
      .mockResolvedValue({ status: "skipped", reason: "no-changes" });
    await h.actions.resumeInterrupted();
    expect(resume.mock.calls[0]?.[0].mode).toBe("full");
    expect(h.opened[0]?.title).toBe("Resuming backup");
  });
});

describe("verify command", () => {
  it("verifies the newest backup, records it, and reports a pass", async () => {
    const h = harness();
    await seed(h.r);
    await h.actions.backupNow();
    h.notices.length = 0;
    await h.actions.verifyLatest(3);
    expect(joined(h)).toContain("passed verification (level 3)");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.result).toBe("pass");
    expect(h.actions.isBusy).toBe(false);
  });

  it("with no backups it says so instead of failing", async () => {
    const h = harness();
    await h.actions.verifyLatest(3);
    expect(joined(h)).toContain("no backups to verify");
  });

  it("a damaged backup is reported as FAILED and marked corrupt", async () => {
    const h = harness();
    await seed(h.r);
    await h.actions.backupNow();
    const index = await loadIndex(h.r.store, "backup");
    const part = `backup/${index.backups[0]!.folder}/part-001.zip`;
    const bytes = (await h.r.store.readBinary(part)).slice();
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await h.r.store.writeBinary(part, bytes);
    h.notices.length = 0;
    await h.actions.verifyLatest(3);
    expect(joined(h)).toContain("FAILED verification");
    expect((await loadIndex(h.r.store, "backup")).backups[0]?.status).toBe("corrupt");
  });

  it("a held lock is reported, not thrown", async () => {
    const h = harness();
    await seed(h.r);
    await h.actions.backupNow();
    await h.r.store.writeBinary(
      "backup/lock.json",
      enc(
        JSON.stringify({
          schemaVersion: 1,
          ownerId: "other",
          platform: "desktop",
          acquiredAt: h.r.clock.now(),
          heartbeatAt: h.r.clock.now(),
        }),
      ),
    );
    h.notices.length = 0;
    await h.actions.verifyLatest(3);
    expect(joined(h)).toContain("Verification did not start");
  });
});
