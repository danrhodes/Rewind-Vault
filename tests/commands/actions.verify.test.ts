import { describe, expect, it } from "vitest";
import { loadIndex } from "../../src/core/BackupIndex";
import { enc } from "../support/engineRig";
import { harness, joined, seed } from "../support/actionsRig";

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

  it("verifies a chosen backup by id, not just the newest", async () => {
    const h = harness();
    await seed(h.r);
    await h.actions.backupFull();
    h.r.clock.advance(60_000);
    await h.r.store.writeBinary("a.md", enc("changed"));
    await h.actions.backupDifferential();
    const oldest = (await loadIndex(h.r.store, "backup")).backups.sort(
      (a, b) => a.createdAt - b.createdAt,
    )[0]!;
    h.notices.length = 0;
    await h.actions.verifyById(oldest.id, 2);
    expect(h.reports[h.reports.length - 1]?.backupId).toBe(oldest.id);
    expect(joined(h)).toContain("passed verification (level 2)");
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
