import { describe, expect, it } from "vitest";
import { resolveChain } from "../../src/core/ChainResolver";
import { loadIndex } from "../../src/core/BackupIndex";
import { CancelledError, RestoreError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

async function scenario(): Promise<{ r: Rig; id: string }> {
  const r = rig();
  await r.store.seed("a.md", "alpha");
  await r.store.seed("docs/b.md", "bravo");
  r.clock.advance(10 * SECOND);
  const { backupId: id } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10 * SECOND);
  await r.store.writeBinary("a.md", enc("alpha EDITED"));
  await r.store.seed("extra.md", "only in the live vault");
  return { r, id };
}

const vaultAll = (id: string) =>
  ({ source: { id }, destination: { kind: "vault" }, overwrite: true }) as const;

describe("pre-restore safety snapshot", () => {
  it("exists, and holds the pre-restore content, BEFORE any file is written", async () => {
    const { r, id } = await scenario();
    let liveAtSnapshot = "";
    const res = await restoreEngineFor(r, {
      safetySnapshot: async () => {
        liveAtSnapshot = await readText(r.store, "a.md"); // nothing written yet
        const s = await r.engine.run({ mode: "diff" });
        return s.status === "completed" ? { backupId: s.backupId } : null;
      },
    }).restoreVault(vaultAll(id));

    expect(liveAtSnapshot).toBe("alpha EDITED");
    expect(await readText(r.store, "a.md")).toBe("alpha"); // restore did happen
    expect(res.snapshot).toMatch(/_diff$/);

    // The snapshot can bring back what the restore overwrote.
    const index = await loadIndex(r.store, "backup");
    const chain = await resolveChain(r.store, "backup", index, { id: res.snapshot as string });
    expect(chain.files.get("a.md")?.entry.size).toBe("alpha EDITED".length);
    expect(chain.files.has("extra.md")).toBe(true);
  });

  it("also protects restoreFile and restoreFolder into the vault", async () => {
    const { r, id } = await scenario();
    const eng = restoreEngineFor(r);
    const one = await eng.restoreFile({ ...vaultAll(id), path: "a.md" });
    expect(one.outcome).toBe("replaced");
    expect(await loadIndex(r.store, "backup").then((i) => i.backups.length)).toBe(2);
  });

  it("is not taken for the restore folder (live vault untouched)", async () => {
    const { r, id } = await scenario();
    let calls = 0;
    await restoreEngineFor(r, {
      safetySnapshot: async () => (calls++, null),
    }).restoreVault({ source: { id } });
    expect(calls).toBe(0);
  });

  it("is not taken when nothing would change", async () => {
    const { r, id } = await scenario();
    await r.store.writeBinary("a.md", enc("alpha"));
    let calls = 0;
    const res = await restoreEngineFor(r, {
      safetySnapshot: async () => (calls++, null),
    }).restoreFile({ ...vaultAll(id), path: "a.md" });
    expect(res.outcome).toBe("unchanged");
    expect(calls).toBe(0);
  });

  it("is not taken when the restore is refused for lack of overwrite", async () => {
    const { r, id } = await scenario();
    let calls = 0;
    await expect(
      restoreEngineFor(r, { safetySnapshot: async () => (calls++, null) }).restoreVault({
        source: { id },
        destination: { kind: "vault" },
      }),
    ).rejects.toThrow(/overwrite was not chosen/);
    expect(calls).toBe(0);
  });

  it("a null snapshot (already up to date) is reported and the restore proceeds", async () => {
    const { r, id } = await scenario();
    const res = await restoreEngineFor(r, {
      safetySnapshot: async () => null,
    }).restoreVault(vaultAll(id));
    expect(res.snapshot).toBe("up-to-date");
    expect(await readText(r.store, "a.md")).toBe("alpha");
  });

  it("refuses to write into the vault when the snapshot fails, writing nothing", async () => {
    const { r, id } = await scenario();
    const boom = new Error("disk full");
    const err = await restoreEngineFor(r, {
      safetySnapshot: async () => {
        throw boom;
      },
    })
      .restoreVault(vaultAll(id))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as RestoreError).cause).toBe(boom);
    expect(await readText(r.store, "a.md")).toBe("alpha EDITED");
    expect(await r.store.exists("docs/b.md")).toBe(true);
  });

  it("refuses when the setting is on but no snapshot function is wired", async () => {
    const { r, id } = await scenario();
    await expect(
      restoreEngineFor(r, { safetySnapshot: undefined }).restoreVault(vaultAll(id)),
    ).rejects.toThrow(/safety snapshot is required/);
    expect(await readText(r.store, "a.md")).toBe("alpha EDITED");
  });

  it("with the setting off, restores without any snapshot", async () => {
    const { r, id } = await scenario();
    r.profile.safety.preRestoreSnapshot = false;
    const res = await restoreEngineFor(r, { safetySnapshot: undefined }).restoreVault(vaultAll(id));
    expect(res.snapshot).toBeUndefined();
    expect(await readText(r.store, "a.md")).toBe("alpha");
  });

  it("a cancelled snapshot passes CancelledError through unchanged", async () => {
    const { r, id } = await scenario();
    await expect(
      restoreEngineFor(r, {
        safetySnapshot: async () => {
          throw new CancelledError();
        },
      }).restoreVault(vaultAll(id)),
    ).rejects.toThrow(CancelledError);
    expect(await readText(r.store, "a.md")).toBe("alpha EDITED");
  });
});
