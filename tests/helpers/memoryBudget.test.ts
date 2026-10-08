import { describe, expect, it } from "vitest";
import {
  LOW_MEMORY,
  NORMAL_YIELD_BUDGET_MS,
  applyLowMemory,
  estimatePeakMb,
  yieldBudgetMs,
} from "../../src/helpers/memoryBudget";
import { createDefaultProfile } from "../../src/settings/defaults";
import { resolveProfile } from "../../src/settings/profiles";
import { createDefaultSettings } from "../../src/settings/defaults";

describe("applyLowMemory", () => {
  it("changes nothing when the mode is off", () => {
    const p = createDefaultProfile("desktop");
    expect(applyLowMemory(p)).toBe(p);
  });

  it("caps part sizes, file counts and chunk size when on, without touching the input", () => {
    const p = createDefaultProfile("desktop");
    p.misc.lowMemoryMode = true;
    const q = applyLowMemory(p);
    expect(q.zip.maxSourceMbPerZip).toBe(LOW_MEMORY.maxSourceMbPerZip);
    expect(q.zip.maxOutputZipMb).toBe(LOW_MEMORY.maxOutputZipMb);
    expect(q.zip.maxFilesPerZip).toBe(LOW_MEMORY.maxFilesPerZip);
    expect(q.misc.chunkSizeKb).toBe(LOW_MEMORY.chunkKb);
    expect(p.zip.maxSourceMbPerZip).toBe(500);
    expect(p.misc.chunkSizeKb).toBe(1024);
  });

  it("never raises a value the user set lower", () => {
    const p = createDefaultProfile("desktop");
    p.misc.lowMemoryMode = true;
    p.zip.maxSourceMbPerZip = 4;
    p.zip.maxFilesPerZip = 10;
    p.misc.chunkSizeKb = 16;
    const q = applyLowMemory(p);
    expect(q.zip.maxSourceMbPerZip).toBe(4);
    expect(q.zip.maxFilesPerZip).toBe(10);
    expect(q.misc.chunkSizeKb).toBe(16);
  });
});

describe("yieldBudgetMs", () => {
  it("is shorter in low-memory mode", () => {
    const p = createDefaultProfile("mobile");
    expect(yieldBudgetMs(p)).toBe(NORMAL_YIELD_BUDGET_MS);
    p.misc.lowMemoryMode = true;
    expect(yieldBudgetMs(p)).toBe(LOW_MEMORY.yieldBudgetMs);
    expect(LOW_MEMORY.yieldBudgetMs).toBeLessThan(NORMAL_YIELD_BUDGET_MS);
  });
});

describe("estimatePeakMb", () => {
  it("stays small in low-memory mode and big otherwise", () => {
    const p = createDefaultProfile("desktop");
    const normal = estimatePeakMb(p);
    p.misc.lowMemoryMode = true;
    const low = estimatePeakMb(p);
    expect(normal).toBeGreaterThan(900);
    expect(low).toBeLessThanOrEqual(33);
  });

  it("the mobile default is under 110 MB, and low-memory mode on mobile under 33 MB", () => {
    const p = createDefaultProfile("mobile");
    expect(estimatePeakMb(p)).toBeLessThan(110);
    p.misc.lowMemoryMode = true;
    expect(estimatePeakMb(p)).toBeLessThan(33);
  });
});

describe("resolveProfile with low-memory mode", () => {
  it("applies the limits to the profile every engine reads", () => {
    const s = createDefaultSettings();
    s.mobile.misc.lowMemoryMode = true;
    const p = resolveProfile(s, "mobile");
    expect(p.zip.maxSourceMbPerZip).toBe(LOW_MEMORY.maxSourceMbPerZip);
    expect(p.misc.chunkSizeKb).toBe(LOW_MEMORY.chunkKb);
    expect(s.mobile.zip.maxSourceMbPerZip).toBe(50);
  });
});
