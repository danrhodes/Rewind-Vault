import { describe, expect, it } from "vitest";
import { BusyFlag } from "../../src/commands/actions";
import { RestoreActions } from "../../src/commands/restoreActions";
import { LinkChecker, type LinkReport } from "../../src/core/LinkReport";
import { Notifier } from "../../src/ui/notify";
import { restoreEngineFor, rig, runOk } from "../support/engineRig";

/** Vault with a.md linking to b and c; the backup has all three notes. Then b.md is lost. */
async function setup(links = true) {
  const r = rig((p) => {
    p.notifications.level = "verbose";
    p.safety.preRestoreSnapshot = false;
  });
  await r.store.seed("a.md", "see [[b]] and [[c]]");
  await r.store.seed("b.md", "b");
  await r.store.seed("c.md", "c");
  r.clock.advance(10_000);
  const { backupId } = await runOk(r.engine, { mode: "full" });
  await r.store.remove("b.md"); // a -> b is now broken
  await r.store.seed("d.md", "[[c]] [[e]]"); // d -> e broken, stays broken

  const notices: string[] = [];
  const reports: LinkReport[] = [];
  const actions = new RestoreActions(
    {
      restore: restoreEngineFor(r),
      notifier: new Notifier(
        (m) => notices.push(m),
        () => r.profile,
      ),
      logger: r.logger,
      progress: {
        open: () => ({
          updateBackup: () => undefined,
          updateRestore: () => undefined,
          close: () => undefined,
        }),
      },
      ...(links
        ? {
            links: new LinkChecker(r.store, () => r.profile),
            showLinkReport: (report: LinkReport) => reports.push(report),
          }
        : {}),
    },
    new BusyFlag(),
  );
  return { r, backupId, actions, notices, reports };
}

describe("restore link report", () => {
  it("lists the links a restore into the vault fixed", async () => {
    const t = await setup();
    const ok = await t.actions.run(
      t.backupId,
      { kind: "vault" },
      { kind: "files", paths: ["b.md"], overwrite: false },
    );
    expect(ok).toBe(true);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]?.fixed).toEqual([{ source: "a.md", target: "b" }]);
    expect(t.reports[0]?.broken).toEqual([]);
    expect(t.notices.join()).toContain("1 link(s) fixed");
  });

  it("lists links a restore broke, as a warning", async () => {
    const t = await setup();
    // Restoring a.md over a changed version that linked elsewhere is not needed: remove c.md
    // in the vault first and restore only a.md, so nothing is fixed.
    await t.r.store.seed("a.md", "see [[c]]");
    await t.r.store.remove("c.md");
    const ok = await t.actions.run(
      t.backupId,
      { kind: "vault" },
      { kind: "files", paths: ["a.md"], overwrite: true },
    );
    expect(ok).toBe(true);
    const report = t.reports[0];
    expect(report?.broken).toEqual([{ source: "a.md", target: "b" }]);
    expect(t.notices.join()).toContain("now broken");
  });

  it("stays quiet when the restore changes no links, and for restore-folder restores", async () => {
    const t = await setup();
    await t.actions.run(
      t.backupId,
      { kind: "restore-folder" },
      { kind: "files", paths: ["b.md"], overwrite: true },
    );
    expect(t.reports).toEqual([]);
    await t.actions.run(
      t.backupId,
      { kind: "vault" },
      { kind: "files", paths: ["c.md"], overwrite: false },
    );
    expect(t.reports).toEqual([]);
  });

  it("works without a link checker", async () => {
    const t = await setup(false);
    const ok = await t.actions.run(
      t.backupId,
      { kind: "vault" },
      { kind: "files", paths: ["b.md"], overwrite: false },
    );
    expect(ok).toBe(true);
    expect(t.reports).toEqual([]);
  });
});
