import { describe, expect, it } from "vitest";
import { autoVerifyLevel } from "../../src/core/AutoVerify";
import { loadIndex } from "../../src/core/BackupIndex";
import { loadManifest } from "../../src/core/Manifest";
import type { AutoVerifyLevel } from "../../src/types";
import { enc, rig, runOk, seedVault, type Rig } from "../support/engineRig";

type Tweak = Parameters<typeof rig>[0];
const withLevel =
  (level: AutoVerifyLevel): Tweak =>
  (p) =>
    void (p.verification.autoVerify = level);

async function backup(tweak: Tweak, mode: "full" | "diff" = "full") {
  const r = rig(tweak);
  await seedVault(r.store, 10);
  const result = await runOk(r.engine, { mode });
  return { r, result, folder: `backup/${result.backupId}` };
}

describe("autoVerifyLevel", () => {
  it("maps the setting to a level", () => {
    expect(autoVerifyLevel("off")).toBeNull();
    expect(autoVerifyLevel("L1")).toBe(1);
    expect(autoVerifyLevel("L2")).toBe(2);
    expect(autoVerifyLevel("L3")).toBe(3);
  });
});

describe("auto-verify after backup", () => {
  it("is on at L2 by default", async () => {
    const { result } = await backup(undefined);
    expect(result.verification).toMatchObject({ level: 2, result: "pass", entriesChecked: 10 });
  });

  it("off: no verification runs and nothing extra is written to the manifest", async () => {
    const { r, result, folder } = await backup(withLevel("off"));
    expect(result.verification).toBeUndefined();
    expect((await loadManifest(r.store, folder)).verify).toBeUndefined();
  });

  it.each([
    ["L1", 1],
    ["L2", 2],
    ["L3", 3],
  ] as const)("%s: runs at exactly that level and records it in the manifest", async (s, n) => {
    const { r, result, folder } = await backup(withLevel(s));
    expect(result.verification).toMatchObject({ level: n, result: "pass" });
    expect((await loadManifest(r.store, folder)).verify).toEqual({
      lastLevel: n,
      lastAt: result.verification?.finishedAt,
      result: "pass",
    });
  });

  it("the setting is read per run: changing it changes the next backup", async () => {
    const { r } = await backup(withLevel("L1"));
    r.profile.verification.autoVerify = "L3";
    await r.store.writeBinary("folder1/sub1/note-1.md", enc("edited"));
    r.clock.advance(1000);
    const next = await runOk(r.engine, { mode: "diff" });
    expect(next.verification?.level).toBe(3);
  });

  it("verifies differential and non-destructive runs too", async () => {
    const r = rig(withLevel("L3"));
    await seedVault(r.store, 10);
    await runOk(r.engine, { mode: "full" });
    await r.store.writeBinary("folder1/sub1/note-1.md", enc("edited"));
    r.clock.advance(1000);
    const diff = await runOk(r.engine, { mode: "diff", nonDestructive: true });
    expect(diff.verification).toMatchObject({ result: "pass", entriesChecked: 1 });
    const manifest = await loadManifest(r.store, `backup/${diff.backupId}`);
    expect(manifest.verify?.result).toBe("pass");
  });

  it("a skipped (no changes) run does not verify anything", async () => {
    const r = rig(withLevel("L2"));
    await seedVault(r.store, 5);
    await runOk(r.engine, { mode: "full" });
    r.clock.advance(1000);
    const again = await r.engine.run({ mode: "diff" });
    expect(again).toEqual({ status: "skipped", reason: "no-changes" });
  });

  it("encrypted backups are verified through the engine's key source", async () => {
    const { result } = await backup((p) => {
      p.verification.autoVerify = "L3";
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    expect(result.verification).toMatchObject({ level: 3, result: "pass", issues: [] });
    expect(result.verification?.skipped).toBeUndefined();
  });
});

/** Make the store damage the first part as it is written, after its hash was computed. */
function corruptPartOnWrite(r: Rig): void {
  const original = r.store.writeBinary.bind(r.store);
  r.store.writeBinary = async (path: string, data: Uint8Array): Promise<void> => {
    if (path.includes("part-001.zip")) {
      const damaged = data.slice();
      const at = Math.floor(damaged.length / 2);
      damaged[at] = (damaged[at] ?? 0) ^ 0xff;
      return original(path, damaged);
    }
    return original(path, data);
  };
}

describe("auto-verify finds a bad backup", () => {
  it("reports the failure, records it, logs an error and still returns the completed run", async () => {
    const r = rig(withLevel("L2"));
    await seedVault(r.store, 10);
    corruptPartOnWrite(r);
    const result = await runOk(r.engine, { mode: "full" });

    expect(result.verification?.result).toBe("fail");
    expect(result.verification?.issues.length).toBeGreaterThan(0);
    const manifest = await loadManifest(r.store, `backup/${result.backupId}`);
    expect(manifest.verify).toMatchObject({ lastLevel: 2, result: "fail" });
    expect(
      r.logger.entries.some((e) => e.level === "error" && /FAILED verification/.test(e.message)),
    ).toBe(true);
    // Marking the backup corrupt is T-074; until then the index still lists it as ok.
    expect((await loadIndex(r.store, "backup")).backups[0]?.status).toBe("ok");
  });

  it("with verification off the same damage goes unnoticed (why the default is on)", async () => {
    const r = rig(withLevel("off"));
    await seedVault(r.store, 10);
    corruptPartOnWrite(r);
    expect((await runOk(r.engine, { mode: "full" })).verification).toBeUndefined();
  });
});
