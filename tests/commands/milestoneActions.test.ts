import { describe, expect, it, vi } from "vitest";
import {
  MAX_MILESTONE_NAME,
  MilestoneActions,
  buildMilestoneCommands,
  normaliseMilestoneName,
} from "../../src/commands/milestoneActions";
import { BackupAdmin } from "../../src/core/BackupAdmin";
import { loadIndex } from "../../src/core/BackupIndex";
import { createDefaultProfile } from "../../src/settings/defaults";
import { Notifier } from "../../src/ui/notify";
import { rig, runOk } from "../support/engineRig";

describe("normaliseMilestoneName", () => {
  it("trims, collapses whitespace and caps the length", () => {
    expect(normaliseMilestoneName("  Before   the\n rewrite ")).toBe("Before the rewrite");
    expect(normaliseMilestoneName("   ")).toBe("");
    expect(normaliseMilestoneName("x".repeat(200))).toHaveLength(MAX_MILESTONE_NAME);
  });
});

async function setup(name: string | null = "  v1.0 release ", madeId: "make" | null = "make") {
  const r = rig();
  await r.store.seed("a.md", "a");
  const profile = createDefaultProfile("desktop");
  profile.notifications.level = "verbose";
  const notices: string[] = [];
  const asked = vi.fn(async () => name);
  const backupForMilestone = vi.fn(async () => {
    if (madeId === null) return null;
    return (await runOk(r.engine, { mode: "full" })).backupId;
  });
  const actions = new MilestoneActions({
    backupForMilestone,
    admin: () =>
      new BackupAdmin({
        store: r.store,
        logger: r.logger,
        clock: r.clock,
        backupFolder: "backup",
        lockTimeoutMin: 30,
        platform: "desktop",
        lockOptions: { sleep: async () => undefined },
      }),
    askName: asked,
    notifier: new Notifier(
      (m) => notices.push(m),
      () => profile,
    ),
  });
  return { r, actions, asked, backupForMilestone, notices };
}

describe("MilestoneActions.create", () => {
  it("makes a full backup and pins it under the cleaned name", async () => {
    const t = await setup();
    await t.actions.create();
    const index = await loadIndex(t.r.store, "backup");
    expect(index.backups).toHaveLength(1);
    expect(index.backups[0]).toMatchObject({ type: "full", pinned: true, label: "v1.0 release" });
    expect(t.notices.join()).toContain("Milestone saved: v1.0 release");
  });

  it("an empty name still pins, without a label", async () => {
    const t = await setup("   ");
    await t.actions.create();
    const entry = (await loadIndex(t.r.store, "backup")).backups[0];
    expect(entry?.pinned).toBe(true);
    expect(entry?.label).toBeUndefined();
  });

  it("does nothing when the name prompt is cancelled", async () => {
    const t = await setup(null);
    await t.actions.create();
    expect(t.backupForMilestone).not.toHaveBeenCalled();
    expect((await loadIndex(t.r.store, "backup")).backups).toHaveLength(0);
  });

  it("pins nothing when no backup was made", async () => {
    const t = await setup("name", null);
    await t.actions.create();
    expect((await loadIndex(t.r.store, "backup")).backups).toHaveLength(0);
    expect(t.notices.join()).not.toContain("Milestone saved");
  });

  it("has one palette command", async () => {
    const t = await setup();
    expect(buildMilestoneCommands(t.actions).map((c) => c.id)).toEqual(["create-milestone"]);
  });
});
