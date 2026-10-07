import { describe, expect, it } from "vitest";
import { createNetworkProbe } from "../../src/helpers/network";
import { evaluateConditions, hasChanges, type ConditionDeps } from "../../src/triggers/Conditions";
import { enc, rig, runOk, type Rig } from "../support/engineRig";
import { MockPlatform } from "../mocks/MockPlatform";

const GB = 1024 * 1024 * 1024;

function depsFor(
  r: Rig,
  extra: Partial<ConditionDeps> = {},
): ConditionDeps & { platform: MockPlatform } {
  const platform = new MockPlatform("mobile");
  return {
    store: r.store,
    logger: r.logger,
    platform,
    getProfile: () => r.profile,
    yieldIfNeeded: async () => undefined,
    ...extra,
  } as ConditionDeps & { platform: MockPlatform };
}

/** A rig whose conditions are all switched off, with one completed backup. */
async function backedUp(): Promise<Rig> {
  const r = rig((p) => {
    p.conditions.minBatteryPct = 0;
    p.conditions.skipIfNoChanges = false;
    p.conditions.minFreeSpaceMb = 0;
    p.conditions.wifiOnly = false;
  });
  await r.store.seed("a.md", "alpha");
  await r.store.seed("docs/b.md", "bravo");
  r.clock.advance(10_000);
  await runOk(r.engine, { mode: "full" });
  return r;
}

describe("battery condition", () => {
  it("is off at 0%", async () => {
    const r = await backedUp();
    const d = depsFor(r);
    d.platform.battery = { level: 1, charging: false };
    expect((await evaluateConditions(d)).ok).toBe(true);
  });

  it("blocks below the minimum while on battery, with a clear message", async () => {
    const r = await backedUp();
    r.profile.conditions.minBatteryPct = 30;
    const d = depsFor(r);
    d.platform.battery = { level: 29, charging: false };
    const res = await evaluateConditions(d);
    expect(res.ok).toBe(false);
    expect(res.blocked).toEqual([
      { condition: "battery", message: "Battery at 29%, below the 30% minimum" },
    ]);
  });

  it("allows exactly the minimum, a higher level, and any level while charging", async () => {
    const r = await backedUp();
    r.profile.conditions.minBatteryPct = 30;
    const d = depsFor(r);
    for (const battery of [
      { level: 30, charging: false },
      { level: 80, charging: false },
      { level: 5, charging: true },
    ]) {
      d.platform.battery = battery;
      expect((await evaluateConditions(d)).ok).toBe(true);
    }
  });

  it("an unavailable battery API never blocks, but is reported as unknown", async () => {
    const r = await backedUp();
    r.profile.conditions.minBatteryPct = 50;
    const d = depsFor(r);
    d.platform.battery = null;
    expect(await evaluateConditions(d)).toEqual({ ok: true, blocked: [], unknown: ["battery"] });
  });
});

describe("wifi condition", () => {
  it("blocks on cellular, allows wifi/ethernet, unknown does not block", async () => {
    const r = await backedUp();
    r.profile.conditions.wifiOnly = true;
    const result = async (type?: string) =>
      evaluateConditions(
        depsFor(r, { network: createNetworkProbe({ connection: type ? { type } : undefined }) }),
      );
    expect((await result("cellular")).blocked[0]?.condition).toBe("wifi");
    expect((await result("wifi")).ok).toBe(true);
    expect((await result("ethernet")).ok).toBe(true);
    expect(await result("unknown")).toMatchObject({ ok: true, unknown: ["wifi"] });
    expect(await result(undefined)).toMatchObject({ ok: true, unknown: ["wifi"] });
  });

  it("is ignored when the setting is off", async () => {
    const r = await backedUp();
    const res = await evaluateConditions(
      depsFor(r, { network: createNetworkProbe({ connection: { type: "cellular" } }) }),
    );
    expect(res.ok).toBe(true);
  });
});

describe("free space condition", () => {
  const probe = (bytes: number | null) => ({ getFreeBytes: async () => bytes });

  it("blocks when free space is below the reserve, passes at or above it", async () => {
    const r = await backedUp();
    r.profile.conditions.minFreeSpaceMb = 200;
    const low = await evaluateConditions(depsFor(r, { freeSpace: probe(100 * 1024 * 1024) }));
    expect(low.blocked[0]).toEqual({
      condition: "free-space",
      message: "Free space below the 200 MB minimum",
    });
    expect((await evaluateConditions(depsFor(r, { freeSpace: probe(200 * 1024 * 1024) }))).ok).toBe(
      true,
    );
    expect((await evaluateConditions(depsFor(r, { freeSpace: probe(5 * GB) }))).ok).toBe(true);
  });

  it("unknown free space does not block; no probe or a 0 MB reserve skips the check", async () => {
    const r = await backedUp();
    r.profile.conditions.minFreeSpaceMb = 200;
    expect(await evaluateConditions(depsFor(r, { freeSpace: probe(null) }))).toMatchObject({
      ok: true,
      unknown: ["free-space"],
    });
    expect((await evaluateConditions(depsFor(r))).unknown).toEqual([]);
    r.profile.conditions.minFreeSpaceMb = 0;
    expect((await evaluateConditions(depsFor(r, { freeSpace: probe(0) }))).ok).toBe(true);
  });
});

describe("no-changes condition", () => {
  it("blocks when the vault matches the last backup", async () => {
    const r = await backedUp();
    r.profile.conditions.skipIfNoChanges = true;
    const res = await evaluateConditions(depsFor(r));
    expect(res.blocked).toEqual([
      { condition: "no-changes", message: "Nothing changed since the last backup" },
    ]);
  });

  it("passes after an edit, an addition or a deletion", async () => {
    const r = await backedUp();
    r.profile.conditions.skipIfNoChanges = true;
    r.clock.advance(5000);
    await r.store.writeBinary("a.md", enc("alpha edited"));
    expect(await hasChanges(depsFor(r))).toBe(true);
    await runOk(r.engine, { mode: "diff" });
    expect(await hasChanges(depsFor(r))).toBe(false);
    await r.store.seed("new.md", "n");
    expect(await hasChanges(depsFor(r))).toBe(true);
    await runOk(r.engine, { mode: "diff" });
    await r.store.remove("docs/b.md");
    expect(await hasChanges(depsFor(r))).toBe(true);
  });

  it("is not blocked when there is no history or the state is unreadable (in doubt, back up)", async () => {
    const fresh = rig((p) => void (p.conditions.skipIfNoChanges = true));
    await fresh.store.seed("a.md", "x");
    expect((await evaluateConditions(depsFor(fresh))).ok).toBe(true);

    const r = await backedUp();
    r.profile.conditions.skipIfNoChanges = true;
    await r.store.writeBinary("backup/state.json", enc("{ broken"));
    expect((await evaluateConditions(depsFor(r))).ok).toBe(true);
  });

  it("is off when the setting is off, and a change inside the backup folder is not a change", async () => {
    const r = await backedUp();
    expect((await evaluateConditions(depsFor(r))).ok).toBe(true);
    r.profile.conditions.skipIfNoChanges = true;
    await r.store.seed("backup/extra-note.md", "ignored");
    expect((await evaluateConditions(depsFor(r))).ok).toBe(false);
  });

  it("the expensive scan is skipped when a cheap condition already blocks", async () => {
    const r = await backedUp();
    r.profile.conditions.skipIfNoChanges = true;
    r.profile.conditions.minBatteryPct = 50;
    const d = depsFor(r);
    d.platform.battery = { level: 10, charging: false };
    const res = await evaluateConditions(d);
    expect(res.blocked.map((b) => b.condition)).toEqual(["battery"]);
  });
});

describe("combined", () => {
  it("lists every blocking cheap condition and logs why the backup was held back", async () => {
    const r = await backedUp();
    r.profile.conditions.minBatteryPct = 50;
    r.profile.conditions.wifiOnly = true;
    r.profile.conditions.minFreeSpaceMb = 500;
    const d = depsFor(r, {
      network: createNetworkProbe({ connection: { type: "cellular" } }),
      freeSpace: { getFreeBytes: async () => 10 },
    });
    d.platform.battery = { level: 5, charging: false };
    const res = await evaluateConditions(d);
    expect(res.blocked.map((b) => b.condition)).toEqual(["battery", "wifi", "free-space"]);
    expect(r.logger.entries.some((e) => /held back/.test(e.message))).toBe(true);
  });

  it("passes with everything satisfied", async () => {
    const r = await backedUp();
    r.profile.conditions.minBatteryPct = 20;
    r.profile.conditions.wifiOnly = true;
    r.profile.conditions.minFreeSpaceMb = 100;
    r.profile.conditions.skipIfNoChanges = true;
    await r.store.seed("changed.md", "c");
    const d = depsFor(r, {
      network: createNetworkProbe({ connection: { type: "wifi" } }),
      freeSpace: { getFreeBytes: async () => 5 * GB },
    });
    d.platform.battery = { level: 60, charging: false };
    expect(await evaluateConditions(d)).toEqual({ ok: true, blocked: [], unknown: [] });
  });
});

describe("createNetworkProbe", () => {
  it("maps connection types", () => {
    const t = (type?: string) =>
      createNetworkProbe({ connection: type ? { type } : undefined }).isUnmetered();
    expect([t("wifi"), t("ethernet"), t("cellular"), t("bluetooth")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([t("none"), t("other"), t()]).toEqual([null, null, null]);
  });
});
