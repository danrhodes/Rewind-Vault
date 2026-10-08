import { describe, expect, it } from "vitest";
import { RestoreError } from "../../src/helpers/errors";
import { enc, restoreEngineFor, rig, runOk } from "../support/engineRig";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("RestoreEngine.readFile", () => {
  async function scenario() {
    const r = rig();
    await r.store.seed("a.md", "a v1");
    await r.store.seed("b.md", "b");
    r.clock.advance(10_000);
    const { backupId: fullId } = await runOk(r.engine, { mode: "full" });
    r.clock.advance(10_000);
    await r.store.writeBinary("a.md", enc("a v2"));
    const { backupId: diffId } = await runOk(r.engine, { mode: "diff" });
    return { r, fullId, diffId };
  }

  it("reads the content a file had in the chosen backup, without writing anything", async () => {
    const { r, fullId, diffId } = await scenario();
    const engine = restoreEngineFor(r);
    expect(dec(await engine.readFile({ id: fullId }, "a.md"))).toBe("a v1");
    expect(dec(await engine.readFile({ id: diffId }, "a.md"))).toBe("a v2");
    expect(await r.store.exists(`restore/${diffId}/a.md`)).toBe(false);
    expect(dec(await r.store.readBinary("a.md"))).toBe("a v2");
  });

  it("follows the chain to a file stored in the base backup", async () => {
    const { r, diffId } = await scenario();
    expect(dec(await restoreEngineFor(r).readFile({ id: diffId }, "b.md"))).toBe("b");
  });

  it("rejects a file the backup does not contain", async () => {
    const { r, fullId } = await scenario();
    await expect(restoreEngineFor(r).readFile({ id: fullId }, "nope.md")).rejects.toBeInstanceOf(
      RestoreError,
    );
  });
});
