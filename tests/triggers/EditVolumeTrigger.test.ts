import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { VaultEventKind } from "../../src/triggers/EventTrigger";
import { EditVolumeTrigger, READ_GAP_MS, countWords } from "../../src/triggers/EditVolumeTrigger";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

function setup(threshold = 50) {
  const profile = createDefaultProfile("desktop");
  profile.triggers.afterWordsEnabled = true;
  profile.triggers.afterWords = threshold;
  const texts = new Map<string, string | null>();
  const reads: string[] = [];
  const fired: TriggerReason[] = [];
  const handlers = new Map<VaultEventKind, Set<(p: string) => void>>();
  let runImpl: () => Promise<void> = async () => undefined;
  const trigger = new EditVolumeTrigger(
    {
      clock: { now: () => Date.now() },
      logger: new MockLogger(),
      getProfile: () => profile,
      run: async (reason) => {
        fired.push(reason);
        await runImpl();
      },
    },
    globalTimerHost,
    {
      on(kind, cb) {
        const set = handlers.get(kind) ?? new Set();
        set.add(cb);
        handlers.set(kind, set);
        return () => set.delete(cb);
      },
    },
    async (path) => {
      reads.push(path);
      return texts.get(path) ?? null;
    },
  );
  const edit = async (path: string, text: string | null, kind: VaultEventKind = "modify") => {
    texts.set(path, text);
    handlers.get(kind)?.forEach((cb) => cb(path));
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
  };
  return {
    trigger,
    profile,
    fired,
    reads,
    handlers,
    edit,
    setRun: (fn: () => Promise<void>) => (runImpl = fn),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("countWords", () => {
  it("counts runs of non-space characters", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  one\ttwo\nthree  four-five ")).toBe(4);
    expect(countWords("# Heading\n\n- [ ] task")).toBe(6);
  });
});

describe("EditVolumeTrigger", () => {
  it("counts nothing the first time a note is seen, then counts the change", async () => {
    const t = setup(50);
    t.trigger.start();
    await t.edit("a.md", words(1000));
    expect(t.trigger.pendingWords).toBe(0);
    await t.edit("a.md", words(1030));
    expect(t.trigger.pendingWords).toBe(30);
    expect(t.fired).toEqual([]);
  });

  it("fires once the total reaches the threshold, across notes, then starts again from zero", async () => {
    const t = setup(50);
    t.trigger.start();
    await t.edit("a.md", words(10));
    await t.edit("b.md", words(10));
    await t.edit("a.md", words(40)); // +30
    await t.edit("b.md", words(30)); // +20 -> 50
    expect(t.fired).toEqual(["words"]);
    expect(t.trigger.pendingWords).toBe(0);
    await t.edit("a.md", words(45)); // +5
    expect(t.trigger.pendingWords).toBe(5);
    expect(t.fired).toEqual(["words"]);
  });

  it("counts deleted words too", async () => {
    const t = setup(50);
    t.trigger.start();
    await t.edit("a.md", words(200));
    await t.edit("a.md", words(140)); // -60
    expect(t.fired).toEqual(["words"]);
  });

  it("reads a note once for a burst of autosaves", async () => {
    const t = setup(50);
    t.trigger.start();
    t.handlers.get("modify")?.forEach((cb) => {
      for (let i = 0; i < 20; i++) cb("a.md");
    });
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    expect(t.reads).toEqual(["a.md"]);
  });

  it("ignores other file types, excluded paths and the backup and restore folders", async () => {
    const t = setup(10);
    t.profile.exclusions.globs = ["private/"];
    t.trigger.start();
    for (const path of ["data.json", "backup/x/note.md", "restore/B1/note.md", "private/n.md"]) {
      await t.edit(path, words(5));
      await t.edit(path, words(500));
    }
    expect(t.fired).toEqual([]);
    expect(t.trigger.pendingWords).toBe(0);
  });

  it("does nothing while the setting is off, and follows it live", async () => {
    const t = setup(10);
    t.profile.triggers.afterWordsEnabled = false;
    t.trigger.start();
    await t.edit("a.md", words(5));
    await t.edit("a.md", words(500));
    expect(t.fired).toEqual([]);
    t.profile.triggers.afterWordsEnabled = true;
    await t.edit("a.md", words(400)); // first seen under the new setting: baseline only
    await t.edit("a.md", words(450));
    expect(t.fired).toEqual(["words"]);
  });

  it("forgets a deleted note's baseline and skips unreadable notes", async () => {
    const t = setup(10);
    t.trigger.start();
    await t.edit("a.md", words(100));
    await t.edit("a.md", null, "delete");
    await t.edit("a.md", words(500)); // a new note with the same name: baseline again
    expect(t.fired).toEqual([]);
    await t.edit("b.md", null); // unreadable
    expect(t.trigger.pendingWords).toBe(0);
  });

  it("does not start a second run while one is going", async () => {
    const t = setup(10);
    let release: () => void = () => undefined;
    t.setRun(() => new Promise<void>((r) => (release = r)));
    t.trigger.start();
    await t.edit("a.md", words(5));
    await t.edit("a.md", words(50));
    expect(t.fired).toHaveLength(1);
    await t.edit("a.md", words(100));
    expect(t.fired).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await t.edit("a.md", words(150));
    expect(t.fired).toHaveLength(2);
  });

  it("stops listening and clears its state on stop", async () => {
    const t = setup(10);
    t.trigger.start();
    await t.edit("a.md", words(5));
    await t.edit("a.md", words(8));
    expect(t.trigger.pendingWords).toBe(3);
    t.trigger.stop();
    expect(t.trigger.isActive).toBe(false);
    expect(t.trigger.pendingWords).toBe(0);
    await t.edit("a.md", words(500));
    expect(t.fired).toEqual([]);
  });
});
