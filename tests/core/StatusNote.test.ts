import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_DAYS,
  healthOf,
  renderStatusNote,
  statusNotePath,
  updateStatusNote,
  type StatusData,
} from "../../src/core/StatusNote";
import { loadIndex } from "../../src/core/BackupIndex";
import { readText } from "../../src/storage/VaultStore";
import { createExcludeCheck, scanOptionsFromProfile, scanVault } from "../../src/core/Scanner";
import { DAY, NOW, indexOf } from "../support/retentionFixtures";
import { enc, rig, runOk } from "../support/engineRig";

const data = (index: StatusData["index"], extra: Partial<StatusData> = {}): StatusData => ({
  index,
  lastVerify: null,
  deepVerify: null,
  now: NOW,
  ...extra,
});

describe("healthOf", () => {
  it("none without backups", () => {
    expect(healthOf(data(indexOf())).status).toBe("none");
  });

  it("ok for a fresh intact backup", () => {
    expect(healthOf(data(indexOf({ id: "A", age: DAY / 2 })))).toEqual({
      status: "ok",
      reasons: [],
    });
  });

  it("warning when the newest good backup is stale", () => {
    const h = healthOf(data(indexOf({ id: "A", age: (STALE_AFTER_DAYS + 1) * DAY })));
    expect(h.status).toBe("warning");
    expect(h.reasons.join()).toContain("days old");
  });

  it("warning for an old damaged backup, error when the newest is damaged or none is intact", () => {
    const old = indexOf({ id: "A", age: DAY }, { id: "B", age: 2 * DAY, status: "corrupt" });
    expect(healthOf(data(old)).status).toBe("warning");
    const newestBad = indexOf({ id: "A", age: 2 * DAY }, { id: "B", age: DAY, status: "corrupt" });
    expect(healthOf(data(newestBad)).status).toBe("error");
    const allBad = indexOf({ id: "A", age: DAY, status: "corrupt" });
    const h = healthOf(data(allBad));
    expect(h.status).toBe("error");
    expect(h.reasons).toContain("No intact backup exists.");
  });

  it("warning when a verification failed", () => {
    const index = indexOf({ id: "A", age: DAY });
    const failed = { lastLevel: 3 as const, lastAt: NOW, result: "fail" as const };
    expect(healthOf(data(index, { lastVerify: failed })).status).toBe("warning");
    expect(
      healthOf(data(index, { deepVerify: { lastRunAt: NOW, backupId: "A", result: "fail" } }))
        .status,
    ).toBe("warning");
  });
});

describe("renderStatusNote", () => {
  const index = indexOf(
    { id: "F", age: 3 * DAY, size: 2048, pinned: true },
    { id: "D", age: DAY / 2, type: "diff", baseId: "F", size: 1024 },
  );

  it("writes frontmatter first, with numbers unquoted and text quoted", () => {
    const text = renderStatusNote(
      data(index, { lastVerify: { lastLevel: 2, lastAt: NOW - 1000, result: "pass" } }),
    );
    expect(text.startsWith("---\n")).toBe(true);
    const front = text.split("---\n")[1] ?? "";
    expect(front).toContain("status: ok\n");
    expect(front).toContain("backups_total: 2\n");
    expect(front).toContain("backups_pinned: 1\n");
    expect(front).toContain("total_size_bytes: 3072\n");
    expect(front).toContain('last_backup_id: "D"\n');
    expect(front).toContain("last_backup_type: diff\n");
    expect(front).toContain("last_backup_age_hours: 12\n");
    expect(front).toContain("last_verify_level: 2\n");
    expect(front).toContain("last_verify_result: pass\n");
    expect(front).toContain(`updated: "${new Date(NOW).toISOString()}"\n`);
  });

  it("lists the backups in a table, newest first, with labels", () => {
    const labelled = indexOf({ id: "F", age: DAY, pinned: true });
    labelled.backups[0] = { ...labelled.backups[0]!, label: "pre|release" };
    const text = renderStatusNote(data(labelled));
    expect(text).toContain("| F (pre/release) | full | ok |");
  });

  it("caps the table and says how many are left out", () => {
    const many = indexOf(...Array.from({ length: 13 }, (_, i) => ({ id: `B${i}`, age: i * 1000 })));
    expect(renderStatusNote(data(many))).toContain("…and 3 older backups.");
  });

  it("handles an empty history", () => {
    const text = renderStatusNote(data(indexOf()));
    expect(text).toContain("status: none\n");
    expect(text).not.toContain("last_backup:");
    expect(text).not.toContain("| Backup |");
  });
});

const noteDeps = (r: ReturnType<typeof rig>) => ({
  store: r.store,
  logger: r.logger,
  clock: r.clock,
  getProfile: () => r.profile,
});

describe("updateStatusNote", () => {
  it("does nothing while the setting is off", async () => {
    const r = rig();
    await r.store.seed("a.md", "a");
    await runOk(r.engine, { mode: "full" });
    expect(await updateStatusNote(noteDeps(r))).toBe(false);
    expect(await r.store.exists("backup/Backup Status.md")).toBe(false);
  });

  it("writes the note into the backup folder by default and keeps it current", async () => {
    const r = rig((p) => void (p.notifications.statusNote = true));
    await r.store.seed("a.md", "a");
    const first = await runOk(r.engine, { mode: "full" });
    expect(await updateStatusNote(noteDeps(r))).toBe(true);
    const text = await readText(r.store, "backup/Backup Status.md");
    expect(text).toContain(`last_backup_id: "${first.backupId}"`);
    expect(text).toContain("backups_total: 1");
    r.clock.advance(60_000);
    await r.store.writeBinary("a.md", enc("b"));
    await runOk(r.engine, { mode: "diff" });
    await updateStatusNote(noteDeps(r));
    expect(await readText(r.store, "backup/Backup Status.md")).toContain("backups_total: 2");
  });

  it("reads the verification result recorded on the newest backup", async () => {
    const r = rig((p) => {
      p.notifications.statusNote = true;
      p.verification.autoVerify = "L2";
    });
    await r.store.seed("a.md", "a");
    await runOk(r.engine, { mode: "full" });
    await updateStatusNote(noteDeps(r));
    expect(await readText(r.store, "backup/Backup Status.md")).toContain(
      "last_verify_result: pass",
    );
    expect((await loadIndex(r.store, "backup")).backups).toHaveLength(1);
  });

  it("uses a configured path, and refuses unsafe or non-note paths with a warning", async () => {
    const r = rig((p) => {
      p.notifications.statusNote = true;
      p.notifications.statusNotePath = "Dashboards/Backup.md";
    });
    await r.store.seed("a.md", "a");
    await runOk(r.engine, { mode: "full" });
    expect(await updateStatusNote(noteDeps(r))).toBe(true);
    expect(await r.store.exists("Dashboards/Backup.md")).toBe(true);
    for (const bad of ["notes.txt", "../x.md", "/abs.md"]) {
      r.profile.notifications.statusNotePath = bad;
      expect(await updateStatusNote(noteDeps(r)), bad).toBe(false);
    }
    expect(r.logger.messages("warn").join()).toContain("not a valid note path");
  });

  it("never throws when the write fails", async () => {
    const r = rig((p) => void (p.notifications.statusNote = true));
    const deps = noteDeps(r);
    deps.store = Object.assign(Object.create(Object.getPrototypeOf(r.store)), r.store, {
      writeBinary: async () => {
        throw new Error("read-only");
      },
    });
    expect(await updateStatusNote(deps)).toBe(false);
    expect(r.logger.messages("warn").join()).toContain("read-only");
  });
});

describe("the status note is never backed up", () => {
  it("is excluded from scans at a custom path, and the default lives in the excluded backup folder", async () => {
    const r = rig((p) => {
      p.notifications.statusNote = true;
      p.notifications.statusNotePath = "Dash/Status.md";
    });
    await r.store.seed("Dash/Status.md", "x");
    await r.store.seed("a.md", "a");
    const files = await scanVault(r.store, scanOptionsFromProfile(r.profile));
    expect(files.map((f) => f.path)).toEqual(["a.md"]);

    r.profile.notifications.statusNotePath = "";
    expect(statusNotePath(r.profile)).toBe("backup/Backup Status.md");
    expect(createExcludeCheck(scanOptionsFromProfile(r.profile))("backup/Backup Status.md")).toBe(
      true,
    );
  });

  it("does not exclude the path while the setting is off", async () => {
    const r = rig((p) => void (p.notifications.statusNotePath = "Dash/Status.md"));
    await r.store.seed("Dash/Status.md", "x");
    const files = await scanVault(r.store, scanOptionsFromProfile(r.profile));
    expect(files.map((f) => f.path)).toEqual(["Dash/Status.md"]);
  });
});
