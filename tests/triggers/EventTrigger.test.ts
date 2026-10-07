import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../../src/settings/defaults";
import {
  EDIT_COALESCE_MS,
  EVENT_DEBOUNCE_MS,
  EventTrigger,
  type VaultEventKind,
  type VaultEvents,
} from "../../src/triggers/EventTrigger";
import { globalTimerHost, type TriggerReason } from "../../src/triggers/TriggerTypes";
import { MockLogger } from "../mocks/MockLogger";

const MIN = 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Triggers = ReturnType<typeof createDefaultProfile>["triggers"];

function setup(tweak: (t: Triggers) => void) {
  const profile = createDefaultProfile("desktop");
  profile.triggers.intervalEnabled = false;
  for (const k of [
    "afterEditsEnabled",
    "idleEnabled",
    "onCreate",
    "onDelete",
    "onRename",
  ] as const) {
    profile.triggers[k] = false;
  }
  tweak(profile.triggers);
  const logger = new MockLogger();
  const fired: TriggerReason[] = [];
  const run = vi.fn<(r: TriggerReason) => Promise<void>>(async (r) => {
    fired.push(r);
  });
  const handlers = new Map<VaultEventKind, Set<(p: string) => void>>();
  const events: VaultEvents = {
    on(kind, cb) {
      const set = handlers.get(kind) ?? new Set();
      set.add(cb);
      handlers.set(kind, set);
      return () => set.delete(cb);
    },
  };
  const emit = (kind: VaultEventKind, path: string): void =>
    handlers.get(kind)?.forEach((cb) => cb(path));
  const trigger = new EventTrigger(
    { clock: { now: () => Date.now() }, logger, getProfile: () => profile, run },
    globalTimerHost,
    events,
  );
  return { trigger, profile, fired, run, emit, logger, handlers };
}

/** n distinct files edited, spaced apart so autosave coalescing never merges them. */
const edit = (s: ReturnType<typeof setup>, ...paths: string[]): void => {
  for (const p of paths) s.emit("modify", p);
};

describe("after N edits", () => {
  it("fires when N edits have happened, then starts counting again", async () => {
    const s = setup((t) => {
      t.afterEditsEnabled = true;
      t.afterEdits = 3;
    });
    s.trigger.start();
    edit(s, "a.md", "b.md");
    expect(s.fired).toEqual([]);
    expect(s.trigger.pendingEdits).toBe(2);
    edit(s, "c.md");
    expect(s.fired).toEqual(["edits"]);
    expect(s.trigger.pendingEdits).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    edit(s, "a.md", "b.md", "c.md");
    expect(s.fired).toEqual(["edits", "edits"]);
  });

  it("an autosave burst on one file counts once; a later edit of it counts again", async () => {
    const s = setup((t) => {
      t.afterEditsEnabled = true;
      t.afterEdits = 100;
    });
    s.trigger.start();
    for (let i = 0; i < 20; i++) {
      s.emit("modify", "note.md");
      await vi.advanceTimersByTimeAsync(2000); // autosave every 2 s
    }
    expect(s.trigger.pendingEdits).toBe(Math.ceil((20 * 2000) / EDIT_COALESCE_MS));
    expect(s.trigger.pendingEdits).toBeLessThan(20);
  });

  it("is off when disabled", () => {
    const s = setup(() => undefined);
    s.trigger.start();
    for (let i = 0; i < 500; i++) s.emit("modify", `f${i}.md`);
    expect(s.fired).toEqual([]);
  });

  it("picks up a changed threshold live", () => {
    const s = setup((t) => {
      t.afterEditsEnabled = true;
      t.afterEdits = 50;
    });
    s.trigger.start();
    edit(s, "a.md", "b.md");
    s.profile.triggers.afterEdits = 2;
    edit(s, "c.md");
    expect(s.fired).toEqual(["edits"]);
  });
});

describe("idle", () => {
  it("fires after N quiet minutes following changes, and the timer restarts on activity", async () => {
    const s = setup((t) => {
      t.idleEnabled = true;
      t.idleMinutes = 10;
    });
    s.trigger.start();
    s.emit("modify", "a.md");
    await vi.advanceTimersByTimeAsync(9 * MIN);
    s.emit("modify", "b.md"); // activity: wait again
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(s.fired).toEqual(["idle"]);
  });

  it("does not fire without changes, and only once per quiet period", async () => {
    const s = setup((t) => {
      t.idleEnabled = true;
      t.idleMinutes = 5;
    });
    s.trigger.start();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.fired).toEqual([]);
    s.emit("create", "x.md");
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.fired).toEqual(["idle"]);
  });

  it("a backup from another trigger resets the idle state", async () => {
    const s = setup((t) => {
      t.idleEnabled = true;
      t.idleMinutes = 10;
      t.afterEditsEnabled = true;
      t.afterEdits = 2;
    });
    s.trigger.start();
    edit(s, "a.md", "b.md"); // fires "edits", clears the idle timer
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.fired).toEqual(["edits"]);
  });
});

describe("create / delete / rename", () => {
  it.each([
    ["create", "onCreate"],
    ["delete", "onDelete"],
    ["rename", "onRename"],
  ] as const)("%s fires after the debounce when %s is on, with that reason", async (kind, flag) => {
    const s = setup((t) => void (t[flag] = true));
    s.trigger.start();
    s.emit(kind, "x.md");
    await vi.advanceTimersByTimeAsync(EVENT_DEBOUNCE_MS - 1);
    expect(s.fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fired).toEqual([kind]);
  });

  it("a bulk operation makes ONE backup: each event restarts the debounce", async () => {
    const s = setup((t) => void (t.onCreate = true));
    s.trigger.start();
    for (let i = 0; i < 200; i++) {
      s.emit("create", `bulk/${i}.md`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(s.fired).toEqual([]); // still going
    await vi.advanceTimersByTimeAsync(EVENT_DEBOUNCE_MS);
    expect(s.fired).toEqual(["create"]);
  });

  it("a mixed burst reports its first kind; kinds that are off are ignored", async () => {
    const s = setup((t) => {
      t.onDelete = true;
      t.onRename = true;
    });
    s.trigger.start();
    s.emit("create", "ignored.md"); // onCreate off
    s.emit("rename", "r.md");
    s.emit("delete", "d.md");
    await vi.advanceTimersByTimeAsync(EVENT_DEBOUNCE_MS);
    expect(s.fired).toEqual(["rename"]);
  });
});

describe("ignored paths and lifecycle", () => {
  it("ignores the backup folder, the restore folder and excluded paths", async () => {
    const s = setup((t) => {
      t.onCreate = true;
      t.afterEditsEnabled = true;
      t.afterEdits = 1;
    });
    s.profile.exclusions.globs = ["private/**"];
    s.trigger.start();
    s.emit("modify", "backup/2026-10-07_full/part-001.zip");
    s.emit("create", "backup/log.txt");
    s.emit("create", `${s.profile.destination.restoreFolder}/x/a.md`);
    s.emit("modify", "private/secret.md");
    s.emit("modify", ".git/index");
    await vi.advanceTimersByTimeAsync(EVENT_DEBOUNCE_MS * 2);
    expect(s.fired).toEqual([]);
    s.emit("modify", "real.md");
    expect(s.fired).toEqual(["edits"]);
  });

  it("does not overlap its own runs; changes during a run count toward the next", async () => {
    let release: () => void = () => undefined;
    const s = setup((t) => {
      t.afterEditsEnabled = true;
      t.afterEdits = 2;
    });
    s.run.mockImplementation(() => new Promise<void>((r) => (release = r)));
    s.trigger.start();
    edit(s, "a.md", "b.md");
    expect(s.run).toHaveBeenCalledTimes(1);
    edit(s, "c.md", "d.md"); // threshold reached while busy: skipped
    expect(s.run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    edit(s, "e.md", "f.md");
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("a failing run is logged and triggering continues", async () => {
    const s = setup((t) => {
      t.afterEditsEnabled = true;
      t.afterEdits = 1;
    });
    s.run.mockRejectedValueOnce(new Error("disk full"));
    s.trigger.start();
    edit(s, "a.md");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.logger.entries.some((e) => e.level === "error" && /disk full/.test(e.message))).toBe(
      true,
    );
    edit(s, "b.md");
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("stop() unsubscribes, cancels timers and forgets pending changes; start() twice does not double up", async () => {
    const s = setup((t) => {
      t.onCreate = true;
      t.idleEnabled = true;
      t.idleMinutes = 5;
    });
    s.trigger.start();
    s.trigger.start();
    expect([...s.handlers.values()].every((set) => set.size === 1)).toBe(true);
    s.emit("create", "a.md");
    s.trigger.stop();
    expect(s.trigger.isActive).toBe(false);
    expect([...s.handlers.values()].every((set) => set.size === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.fired).toEqual([]);
    s.emit("create", "b.md");
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.fired).toEqual([]);
  });
});
