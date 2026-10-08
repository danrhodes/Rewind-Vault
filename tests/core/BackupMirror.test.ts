import { describe, expect, it } from "vitest";
import { BackupMirror } from "../../src/core/BackupMirror";
import type { ExternalFs } from "../../src/storage/ExternalCopy";
import { ExternalCopy } from "../../src/storage/ExternalCopy";
import { MockPlatform } from "../mocks/MockPlatform";
import { rig, runOk } from "../support/engineRig";

class MemoryFs implements ExternalFs {
  files = new Map<string, Uint8Array>();
  fail = false;
  async mkdir(): Promise<void> {}
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (this.fail) throw new Error("drive removed");
    this.files.set(path, data);
  }
  async rename(from: string, to: string): Promise<void> {
    this.files.set(to, this.files.get(from) as Uint8Array);
    this.files.delete(from);
  }
  async stat(path: string): Promise<{ size: number }> {
    return { size: (this.files.get(path) as Uint8Array).length };
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function setup(
  options: {
    destination?: "vault" | "external";
    externalPath?: string;
    kind?: "desktop" | "mobile";
    noFs?: boolean;
    afterRun?: () => Promise<unknown>;
  } = {},
) {
  const r = rig((p) => {
    p.destination.destination = options.destination ?? "external";
    p.destination.externalPath = options.externalPath ?? "/mnt/ext";
  });
  const fs = new MemoryFs();
  const platform = new MockPlatform(options.kind ?? "desktop");
  const mirror = new BackupMirror({
    engine: r.engine,
    copier: options.noFs ? null : new ExternalCopy(r.store, fs, r.logger),
    platform,
    logger: r.logger,
    getProfile: () => r.profile,
    store: r.store,
    afterRun: options.afterRun,
  });
  return { r, fs, mirror };
}

describe("BackupMirror", () => {
  it("copies a completed backup outside the vault and reports it", async () => {
    const { r, fs, mirror } = setup();
    await r.store.seed("a.md", "alpha");
    const result = await mirror.run({ mode: "full" });
    if (result.status !== "completed") throw new Error("expected a completed backup");
    expect(result.externalCopy?.ok).toBe(true);
    const names = [...fs.files.keys()].sort();
    expect(names).toContain(`/mnt/ext/${result.backupId}/manifest.json`);
    expect(names.some((n) => n.includes("part-001.zip"))).toBe(true);
    // The backup is still in the vault too.
    expect(await r.store.exists(`backup/${result.backupId}/manifest.json`)).toBe(true);
  });

  it("does nothing when the destination is the vault", async () => {
    const { r, fs, mirror } = setup({ destination: "vault" });
    await r.store.seed("a.md", "alpha");
    const result = await runOk(mirror as never, { mode: "full" });
    expect(result.externalCopy).toBeUndefined();
    expect(fs.files.size).toBe(0);
  });

  it("does not copy a skipped run", async () => {
    const { r, fs, mirror } = setup();
    await r.store.seed("a.md", "alpha");
    await mirror.run({ mode: "full" });
    fs.files.clear();
    r.clock.advance(60_000);
    expect(await mirror.run({ mode: "diff" })).toEqual({ status: "skipped", reason: "no-changes" });
    expect(fs.files.size).toBe(0);
  });

  it("keeps the backup and reports a failed copy", async () => {
    const { r, fs, mirror } = setup();
    fs.fail = true;
    await r.store.seed("a.md", "alpha");
    const result = await mirror.run({ mode: "full" });
    if (result.status !== "completed") throw new Error("expected a completed backup");
    expect(result.externalCopy).toMatchObject({ ok: false });
    expect(result.externalCopy?.message).toContain("drive removed");
    expect(await r.store.exists(`backup/${result.backupId}/manifest.json`)).toBe(true);
    expect(r.logger.messages("error").join()).toContain("External copy failed");
  });

  it("reports a bad path, mobile, and a missing Node fs without copying", async () => {
    for (const options of [
      { externalPath: "relative/path" },
      { externalPath: "" },
      { kind: "mobile" as const },
      { noFs: true },
    ]) {
      const { r, fs, mirror } = setup(options);
      await r.store.seed("a.md", "alpha");
      const result = await mirror.run({ mode: "full" });
      if (result.status !== "completed") throw new Error("expected a completed backup");
      expect(result.externalCopy?.ok, JSON.stringify(options)).toBe(false);
      expect(fs.files.size).toBe(0);
    }
  });
});

describe("BackupMirror afterRun", () => {
  it("runs after a completed and after a skipped backup, and its failure is ignored", async () => {
    let calls = 0;
    const { r, mirror } = setup({
      destination: "vault",
      afterRun: async () => {
        calls++;
        throw new Error("note write failed");
      },
    });
    await r.store.seed("a.md", "alpha");
    expect((await mirror.run({ mode: "full" })).status).toBe("completed");
    r.clock.advance(60_000);
    expect((await mirror.run({ mode: "diff" })).status).toBe("skipped");
    expect(calls).toBe(2);
  });

  it("does not run when the backup fails", async () => {
    let calls = 0;
    const { r, mirror } = setup({
      destination: "vault",
      afterRun: async () => {
        calls++;
      },
    });
    await r.store.seed("a.md", "alpha");
    await expect(mirror.run({ mode: "full", isCancelled: () => true })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
