import { describe, expect, it } from "vitest";
import { countsTowardRetention, loadIndex } from "../../src/core/BackupIndex";
import { recordVerification } from "../../src/core/BackupFailure";
import { loadManifest } from "../../src/core/Manifest";
import { BrokenChainError } from "../../src/helpers/errors";
import { enc, restoreEngineFor, rig, runOk, verifyEngineFor, type Rig } from "../support/engineRig";

const SECOND = 1000;

interface Harness {
  r: Rig;
  /** While true, the next part written is damaged after its hash was computed. */
  damage: { on: boolean };
}

function harness(tweak?: Parameters<typeof rig>[0]): Harness {
  const r = rig(tweak);
  const damage = { on: false };
  const original = r.store.writeBinary.bind(r.store);
  r.store.writeBinary = async (path: string, data: Uint8Array): Promise<void> => {
    if (damage.on && path.includes("part-001.zip")) {
      const bad = data.slice();
      const at = Math.floor(bad.length / 2);
      bad[at] = (bad[at] ?? 0) ^ 0xff;
      return original(path, bad);
    }
    return original(path, data);
  };
  return { r, damage };
}

async function run(h: Harness, mode: "full" | "diff", damaged = false, edit = true) {
  h.r.clock.advance(10 * SECOND);
  if (edit) await h.r.store.writeBinary("a.md", enc(`a at ${h.r.clock.now()}`));
  h.damage.on = damaged;
  try {
    return await runOk(h.r.engine, { mode });
  } finally {
    h.damage.on = false;
  }
}

async function statuses(r: Rig): Promise<string[]> {
  const index = await loadIndex(r.store, "backup");
  return [...index.backups].sort((a, b) => a.createdAt - b.createdAt).map((b) => b.status);
}

async function seeded(tweak?: Parameters<typeof rig>[0]): Promise<Harness> {
  const h = harness(tweak);
  await h.r.store.seed("a.md", "a");
  await h.r.store.seed("b.md", "b");
  return h;
}

describe("failed verification: marking", () => {
  it("marks the backup corrupt in the index and the manifest, and leaves the others alone", async () => {
    const h = await seeded();
    const good = await run(h, "full");
    const goodPart = await h.r.store.readBinary(`backup/${good.backupId}/part-001.zip`);
    const bad = await run(h, "diff", true);

    expect(bad.verification?.result).toBe("fail");
    expect(await statuses(h.r)).toEqual(["ok", "corrupt"]);
    const manifest = await loadManifest(h.r.store, `backup/${bad.backupId}`);
    expect(manifest.status).toBe("corrupt");
    expect(manifest.verify).toMatchObject({ lastLevel: 2, result: "fail" });
    expect((await loadManifest(h.r.store, `backup/${good.backupId}`)).status).toBe("ok");
    expect(await h.r.store.readBinary(`backup/${good.backupId}/part-001.zip`)).toEqual(goodPart);
  });

  it("a passing backup stays ok", async () => {
    const h = await seeded();
    await run(h, "full");
    expect(await statuses(h.r)).toEqual(["ok"]);
  });

  it("recordVerification is idempotent: a second failure is not 'newly' corrupt", async () => {
    const h = await seeded();
    const bad = await run(h, "full", true);
    const report = bad.verification;
    if (!report) throw new Error("expected a report");
    expect(await recordVerification(h.r.store, "backup", report, h.r.logger)).toBe(false);
    expect(await statuses(h.r)).toEqual(["corrupt"]);
  });

  it("a later pass does not heal a backup marked corrupt (only manifest.verify is updated)", async () => {
    const h = await seeded();
    const bad = await run(h, "full", true);
    const pass = { ...(bad.verification as NonNullable<typeof bad.verification>) };
    pass.result = "pass";
    pass.issues = [];
    pass.level = 3;
    expect(await recordVerification(h.r.store, "backup", pass, h.r.logger)).toBe(false);
    expect(await statuses(h.r)).toEqual(["corrupt"]);
    const m = await loadManifest(h.r.store, `backup/${bad.backupId}`);
    expect(m.status).toBe("corrupt");
    expect(m.verify).toMatchObject({ lastLevel: 3, result: "pass" });
  });

  it("standalone verification of an older backup that rotted marks it corrupt", async () => {
    const h = await seeded();
    const good = await run(h, "full");
    const part = `backup/${good.backupId}/part-001.zip`;
    const bytes = (await h.r.store.readBinary(part)).slice();
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await h.r.store.writeBinary(part, bytes);

    const report = await verifyEngineFor(h.r).verify(good.backupId, { level: 2 });
    expect(report.result).toBe("fail");
    expect(await recordVerification(h.r.store, "backup", report, h.r.logger)).toBe(true);
    expect(await statuses(h.r)).toEqual(["corrupt"]);
  });
});

describe("failed verification: consequences", () => {
  it("restore refuses a corrupt backup, and point-in-time skips it", async () => {
    const h = await seeded();
    const good = await run(h, "full");
    const bad = await run(h, "diff", true);
    const eng = restoreEngineFor(h.r);
    await expect(eng.restoreVault({ source: { id: bad.backupId } })).rejects.toThrow(
      BrokenChainError,
    );
    const at = await eng.preview({
      source: { at: h.r.clock.now() },
      scope: { kind: "all" },
      destination: { kind: "restore-folder" },
    });
    expect(at.source.id).toBe(good.backupId);
  });

  it("the next differential is forced to a full backup, then differentials resume", async () => {
    const h = await seeded();
    await run(h, "full");
    await run(h, "diff", true); // corrupt
    const next = await run(h, "diff");
    expect(next).toMatchObject({ type: "full" });
    expect(next.forcedFullReason).toMatch(/failed verification/);
    expect(next.verification?.result).toBe("pass");
    const after = await run(h, "diff");
    expect(after.type).toBe("diff");
    expect(after.forcedFullReason).toBeUndefined();
    expect(await statuses(h.r)).toEqual(["ok", "corrupt", "ok", "ok"]);
  });

  it("the forced full contains every file, so nothing the failed backup held is lost", async () => {
    const h = await seeded();
    await run(h, "full");
    await run(h, "diff", true);
    const next = await run(h, "diff");
    expect(next.fileCount).toBe(2);
    const restored = await restoreEngineFor(h.r).restoreVault({ source: { id: next.backupId } });
    expect(restored.created).toBe(2);
  });

  it("a failed FULL backup also forces the next run to be full", async () => {
    const h = await seeded();
    await run(h, "full");
    await run(h, "full", true); // newer full, corrupt: the older full is still the base
    const next = await run(h, "diff");
    expect(next.type).toBe("full");
    expect(next.forcedFullReason).toMatch(/failed verification/);
  });

  it("a corrupt backup older than the newest intact full no longer forces anything", async () => {
    const h = await seeded();
    await run(h, "full");
    await run(h, "diff", true);
    await run(h, "diff"); // forced full, ok
    const next = await run(h, "diff");
    expect(next.type).toBe("diff");
  });

  it("with onFailureForceFull off the next run stays differential (and its chain is unrestorable)", async () => {
    const h = await seeded((p) => void (p.verification.onFailureForceFull = false));
    await run(h, "full");
    await run(h, "diff", true);
    const next = await run(h, "diff");
    expect(next.type).toBe("diff");
    await expect(
      restoreEngineFor(h.r).restoreVault({ source: { id: next.backupId } }),
    ).rejects.toThrow(BrokenChainError);
  });

  it("a crash between marking the index and the manifest still leaves the backup refused", async () => {
    const h = await seeded();
    const bad = await run(h, "full", true);
    // Undo the manifest half of the write: only the index says corrupt.
    const m = await loadManifest(h.r.store, `backup/${bad.backupId}`);
    m.status = "ok";
    await h.r.store.writeBinary(`backup/${bad.backupId}/manifest.json`, enc(JSON.stringify(m)));
    await expect(
      restoreEngineFor(h.r).restoreVault({ source: { id: bad.backupId } }),
    ).rejects.toThrow(BrokenChainError);
  });
});

describe("retention counting", () => {
  it("only ok backups count toward retention", async () => {
    const h = await seeded();
    await run(h, "full");
    await run(h, "diff", true);
    const { backups } = await loadIndex(h.r.store, "backup");
    expect(backups.map(countsTowardRetention).sort()).toEqual([false, true]);
    expect(backups.every((b) => countsTowardRetention({ ...b, status: "in-progress" }))).toBe(
      false,
    );
  });
});
