import { describe, expect, it } from "vitest";
import { InsufficientSpaceError } from "../../src/helpers/errors";
import {
  assertFreeSpace,
  checkFreeSpace,
  createStorageEstimateProbe,
  estimateBackupBytes,
  type IFreeSpaceProbe,
} from "../../src/storage/FreeSpace";

const MB = 1024 * 1024;
const probe = (free: number | null): IFreeSpaceProbe => ({ getFreeBytes: async () => free });

describe("estimateBackupBytes", () => {
  it("sums sizes; level 0 is uncompressed, others assume 60%", () => {
    const files = [{ size: 100 }, { size: 900 }];
    expect(estimateBackupBytes(files, 0)).toBe(1000);
    expect(estimateBackupBytes(files, 6)).toBe(600);
    expect(estimateBackupBytes([], 6)).toBe(0);
  });
});

describe("checkFreeSpace", () => {
  it("passes when free >= required + reserve (boundary inclusive)", async () => {
    expect((await checkFreeSpace(probe(300 * MB), 100 * MB, 200)).ok).toBe(true);
    expect((await checkFreeSpace(probe(300 * MB - 1), 100 * MB, 200)).ok).toBe(false);
  });

  it("passes but reports unknown when the platform cannot say", async () => {
    const r = await checkFreeSpace(probe(null), 10 ** 12, 200);
    expect(r).toMatchObject({ ok: true, known: false, freeBytes: null });
  });
});

describe("assertFreeSpace", () => {
  it("throws InsufficientSpaceError with needed and available bytes", async () => {
    const err = await assertFreeSpace(probe(50 * MB), 100 * MB, 200).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientSpaceError);
    expect((err as InsufficientSpaceError).requiredBytes).toBe(300 * MB);
    expect((err as InsufficientSpaceError).availableBytes).toBe(50 * MB);
  });

  it("returns the result when there is room or space is unknown", async () => {
    expect((await assertFreeSpace(probe(10 * 1024 * MB), MB, 200)).ok).toBe(true);
    expect((await assertFreeSpace(probe(null), MB, 200)).known).toBe(false);
  });
});

describe("createStorageEstimateProbe", () => {
  it("returns quota minus usage, never negative", async () => {
    const p = createStorageEstimateProbe({ estimate: async () => ({ quota: 1000, usage: 400 }) });
    expect(await p.getFreeBytes()).toBe(600);
    const over = createStorageEstimateProbe({ estimate: async () => ({ quota: 100, usage: 400 }) });
    expect(await over.getFreeBytes()).toBe(0);
  });

  it("returns null when unsupported, incomplete or failing", async () => {
    expect(
      await createStorageEstimateProbe({ estimate: async () => ({}) }).getFreeBytes(),
    ).toBeNull();
    const failing = createStorageEstimateProbe({
      estimate: async () => {
        throw new Error("denied");
      },
    });
    expect(await failing.getFreeBytes()).toBeNull();
  });
});
