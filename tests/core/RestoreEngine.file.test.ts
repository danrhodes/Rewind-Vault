import { describe, expect, it } from "vitest";
import { RestoreEngine } from "../../src/core/RestoreEngine";
import { BrokenChainError, RestoreError, VerificationError } from "../../src/helpers/errors";
import { readText } from "../../src/storage/VaultStore";
import { enc, fastMaster, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

const SECOND = 1000;

/** Full backup of a.md, docs/b.md; then a differential where a.md is edited and c.md is added. */
async function scenario(
  tweak?: Parameters<typeof rig>[0],
): Promise<{ r: Rig; fullId: string; diffId: string }> {
  const r = rig(tweak);
  await r.store.seed("a.md", "alpha v1");
  await r.store.seed("docs/b.md", "bravo");
  r.clock.advance(10 * SECOND);
  const { backupId: fullId } = await runOk(r.engine, { mode: "full" });
  r.clock.advance(10 * SECOND);
  await r.store.writeBinary("a.md", enc("alpha v2 edited"));
  await r.store.seed("c.md", "charlie");
  const { backupId: diffId } = await runOk(r.engine, { mode: "diff" });
  return { r, fullId, diffId };
}

describe("restoreFile: restore folder (default)", () => {
  it("writes the file under <restoreFolder>/<id>/ and leaves the live vault alone", async () => {
    const { r, diffId } = await scenario();
    const res = await restoreEngineFor(r).restoreFile({
      source: { id: diffId },
      path: "a.md",
      destination: { kind: "restore-folder" },
    });
    expect(res).toMatchObject({
      writtenTo: `restore/${diffId}/a.md`,
      outcome: "created",
      backupId: diffId,
    });
    expect(await readText(r.store, `restore/${diffId}/a.md`)).toBe("alpha v2 edited");
    expect(await readText(r.store, "a.md")).toBe("alpha v2 edited"); // live untouched
  });

  it("restores a file whose stored version lives in an older backup", async () => {
    const { r, fullId, diffId } = await scenario();
    const res = await restoreEngineFor(r).restoreFile({
      source: { id: diffId },
      path: "docs/b.md",
      destination: { kind: "restore-folder" },
    });
    expect(res.backupId).toBe(fullId);
    expect(await readText(r.store, `restore/${diffId}/docs/b.md`)).toBe("bravo");
  });

  it("restores the older version of an edited file from the older backup", async () => {
    const { r, fullId } = await scenario();
    await restoreEngineFor(r).restoreFile({
      source: { id: fullId },
      path: "a.md",
      destination: { kind: "restore-folder" },
    });
    expect(await readText(r.store, `restore/${fullId}/a.md`)).toBe("alpha v1");
  });

  it("resolves a point in time", async () => {
    const { r, fullId } = await scenario();
    const res = await restoreEngineFor(r).restoreFile({
      source: { at: r.clock.now() - 5 * SECOND },
      path: "a.md",
      destination: { kind: "restore-folder" },
    });
    expect(res.writtenTo).toBe(`restore/${fullId}/a.md`);
  });
});

describe("restoreFile: vault destination and overwrite", () => {
  it("creates a file that is missing from the live vault", async () => {
    const { r, diffId } = await scenario();
    await r.store.remove("docs/b.md");
    const res = await restoreEngineFor(r).restoreFile({
      source: { id: diffId },
      path: "docs/b.md",
      destination: { kind: "vault" },
    });
    expect(res).toMatchObject({ writtenTo: "docs/b.md", outcome: "created" });
    expect(await readText(r.store, "docs/b.md")).toBe("bravo");
  });

  it("refuses to replace a differing file unless overwrite is chosen, writing nothing", async () => {
    const { r, fullId } = await scenario();
    const before = await r.store.list("");
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: fullId },
        path: "a.md",
        destination: { kind: "vault" },
      }),
    ).rejects.toThrow(RestoreError);
    expect(await readText(r.store, "a.md")).toBe("alpha v2 edited");
    expect(await r.store.list("")).toEqual(before);
  });

  it("replaces a differing file with overwrite", async () => {
    const { r, fullId } = await scenario();
    const res = await restoreEngineFor(r).restoreFile({
      source: { id: fullId },
      path: "a.md",
      destination: { kind: "vault" },
      overwrite: true,
    });
    expect(res.outcome).toBe("replaced");
    expect(await readText(r.store, "a.md")).toBe("alpha v1");
    expect(await r.store.exists("a.md.tmp")).toBe(false);
    expect(await r.store.exists("a.md.bak")).toBe(false);
  });

  it("reports identical content as unchanged without writing", async () => {
    const { r, diffId } = await scenario();
    const res = await restoreEngineFor(r).restoreFile({
      source: { id: diffId },
      path: "a.md",
      destination: { kind: "vault" },
    });
    expect(res.outcome).toBe("unchanged");
  });

  it("restores binary content byte for byte", async () => {
    const r = rig();
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) % 256);
    await r.store.writeBinary("img/x.png", bytes);
    r.clock.advance(SECOND);
    const { backupId } = await runOk(r.engine, { mode: "full" });
    await restoreEngineFor(r).restoreFile({
      source: { id: backupId },
      path: "img/x.png",
      destination: { kind: "restore-folder" },
    });
    expect(await r.store.readBinary(`restore/${backupId}/img/x.png`)).toEqual(bytes);
  });
});

describe("restoreFile: failures", () => {
  it("rejects a path that is not in the backup", async () => {
    const { r, fullId } = await scenario();
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: fullId },
        path: "c.md", // added only in the later backup
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toThrow(/not in backup/);
  });

  it.each(["../escape.md", "/abs.md", "a//b.md", ""])("rejects unsafe path %j", async (path) => {
    const { r, fullId } = await scenario();
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: fullId },
        path,
        destination: { kind: "vault" },
      }),
    ).rejects.toThrow(RestoreError);
  });

  it("rejects an unknown backup id", async () => {
    const { r } = await scenario();
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: "nope" },
        path: "a.md",
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toThrow(BrokenChainError);
  });

  it("fails before writing when the part file is missing", async () => {
    const { r, fullId } = await scenario();
    await r.store.remove(`backup/${fullId}/part-001.zip`);
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: fullId },
        path: "a.md",
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toThrow(BrokenChainError);
    expect(await r.store.exists(`restore/${fullId}/a.md`)).toBe(false);
  });

  it("never writes corrupt data: a flipped byte in the part is detected", async () => {
    const r = rig((p) => void (p.zip.compressionLevel = 0));
    await r.store.seed("a.md", "alpha content that is long enough to find");
    const { backupId } = await runOk(r.engine, { mode: "full" });
    const part = `backup/${backupId}/part-001.zip`;
    const bytes = await r.store.readBinary(part);
    const at = new TextDecoder("latin1").decode(bytes).indexOf("alpha content");
    const damaged = bytes.slice();
    damaged[at + 2] = (damaged[at + 2] ?? 0) ^ 0xff;
    await r.store.writeBinary(part, damaged);
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: backupId },
        path: "a.md",
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toThrow(VerificationError);
    expect(await r.store.exists(`restore/${backupId}/a.md`)).toBe(false);
  });

  it("refuses when a folder is in the way", async () => {
    const { r, fullId } = await scenario();
    await r.store.mkdir(`restore/${fullId}/a.md`);
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: fullId },
        path: "a.md",
        destination: { kind: "restore-folder" },
        overwrite: true,
      }),
    ).rejects.toThrow(/folder is in the way/);
  });
});

describe("restoreFile: encrypted backups", () => {
  it("decrypts with the derived key", async () => {
    const { r, fullId } = await scenario((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    const engine = new RestoreEngine({
      store: r.store,
      logger: r.logger,
      clock: r.clock,
      getProfile: () => r.profile,
      yieldIfNeeded: async () => undefined,
      deriveMasterKey: fastMaster,
    });
    await engine.restoreFile({
      source: { id: fullId },
      path: "a.md",
      destination: { kind: "restore-folder" },
    });
    expect(await readText(r.store, `restore/${fullId}/a.md`)).toBe("alpha v1");
  });

  it("fails clearly without a passphrase source, and writes nothing", async () => {
    const { r, fullId } = await scenario((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    await expect(
      restoreEngineFor(r).restoreFile({
        source: { id: fullId },
        path: "a.md",
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toThrow(/passphrase/);
    expect(await r.store.exists(`restore/${fullId}/a.md`)).toBe(false);
  });

  it("a wrong key fails with a typed error and writes nothing", async () => {
    const { r, fullId } = await scenario((p) => {
      p.encryption.enabled = true;
      p.encryption.kdfIterations = 600_000;
    });
    const engine = new RestoreEngine({
      store: r.store,
      logger: r.logger,
      clock: r.clock,
      getProfile: () => r.profile,
      yieldIfNeeded: async () => undefined,
      deriveMasterKey: async (salt) => fastMaster(new Uint8Array([...salt, 1])),
    });
    await expect(
      engine.restoreFile({
        source: { id: fullId },
        path: "a.md",
        destination: { kind: "restore-folder" },
      }),
    ).rejects.toThrow();
    expect(await r.store.exists(`restore/${fullId}/a.md`)).toBe(false);
  });
});
