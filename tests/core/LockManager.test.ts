import { describe, expect, it } from "vitest";
import { LockManager } from "../../src/core/LockManager";
import { LockError } from "../../src/helpers/errors";
import { MockClock } from "../mocks/MockClock";
import { MockVaultStore } from "../mocks/MockVaultStore";

const MIN = 60_000;

function setup(timeoutMin = 30) {
  const clock = new MockClock(1_000_000);
  const store = new MockVaultStore(clock);
  let n = 0;
  const make = (id?: string, sleep?: (ms: number) => Promise<void>) =>
    new LockManager(store, "backup", clock, {
      timeoutMin,
      platform: "desktop",
      newId: () => id ?? `owner-${++n}`,
      sleep: sleep ?? (async () => undefined),
    });
  return { clock, store, make };
}

describe("LockManager basics", () => {
  it("acquire writes lock.json, release removes it", async () => {
    const { store, make } = setup();
    const lock = make("A");
    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    const info = await lock.read();
    expect(info).toMatchObject({ ownerId: "A", platform: "desktop", acquiredAt: 1_000_000 });
    await lock.release();
    expect(lock.isHeld).toBe(false);
    expect(await store.exists("backup/lock.json")).toBe(false);
  });

  it("a second manager is refused while the first holds a live lock", async () => {
    const { make } = setup();
    const a = make("A");
    const b = make("B");
    await a.acquire();
    await expect(b.acquire()).rejects.toBeInstanceOf(LockError);
    expect(b.isHeld).toBe(false);
  });

  it("the same instance cannot acquire twice", async () => {
    const { make } = setup();
    const a = make("A");
    await a.acquire();
    await expect(a.acquire()).rejects.toBeInstanceOf(LockError);
  });

  it("after release another manager can acquire", async () => {
    const { make } = setup();
    const a = make("A");
    const b = make("B");
    await a.acquire();
    await a.release();
    await b.acquire();
    expect((await b.read())?.ownerId).toBe("B");
  });

  it("release is safe when nothing is held and never removes another owner's lock", async () => {
    const { store, make } = setup();
    const a = make("A");
    const b = make("B");
    await b.release();
    await a.acquire();
    await b.release();
    expect(await store.exists("backup/lock.json")).toBe(true);
    expect((await a.read())?.ownerId).toBe("A");
  });
});

describe("stale detection", () => {
  it("a lock past the timeout is taken over; one inside it is not", async () => {
    const { clock, make } = setup(30);
    const a = make("A");
    const b = make("B");
    await a.acquire();

    clock.advance(30 * MIN);
    await expect(b.acquire()).rejects.toBeInstanceOf(LockError); // exactly at the timeout: still live

    clock.advance(1);
    await b.acquire();
    expect((await b.read())?.ownerId).toBe("B");
  });

  it("isStale reflects the heartbeat", async () => {
    const { clock, make } = setup(10);
    const a = make("A");
    await a.acquire();
    const info = (await a.read())!;
    expect(a.isStale(info)).toBe(false);
    clock.advance(10 * MIN + 1);
    expect(a.isStale(info)).toBe(true);
  });

  it("refresh moves the heartbeat so a long run is not taken over", async () => {
    const { clock, make } = setup(10);
    const a = make("A");
    const b = make("B");
    await a.acquire();
    clock.advance(8 * MIN);
    await a.refresh();
    clock.advance(8 * MIN);
    await expect(b.acquire()).rejects.toBeInstanceOf(LockError);
    expect((await a.read())?.acquiredAt).toBe(1_000_000);
  });

  it("an unreadable lock file counts as abandoned", async () => {
    const { store, make } = setup();
    await store.seed("backup/lock.json", "{ half writ");
    const a = make("A");
    await a.acquire();
    expect((await a.read())?.ownerId).toBe("A");
  });

  it("a taken-over owner finds out on refresh", async () => {
    const { clock, make } = setup(10);
    const a = make("A");
    const b = make("B");
    await a.acquire();
    clock.advance(11 * MIN);
    await b.acquire();
    await expect(a.refresh()).rejects.toBeInstanceOf(LockError);
    expect(a.isHeld).toBe(false);
    await a.release(); // must not delete B's lock
    expect((await b.read())?.ownerId).toBe("B");
  });

  it("refresh without holding the lock fails", async () => {
    const { make } = setup();
    await expect(make("A").refresh()).rejects.toBeInstanceOf(LockError);
  });
});

describe("concurrent runs", () => {
  it("two simultaneous acquires on one instance: exactly one wins", async () => {
    const { make } = setup();
    const a = make("A");
    const results = await Promise.allSettled([a.acquire(), a.acquire()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("two managers racing from an empty folder: exactly one ends up holding", async () => {
    const { make } = setup();
    // Yielding sleep lets both write before either confirms, the worst interleaving.
    const yieldSome = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const a = make("A", yieldSome);
    const b = make("B", yieldSome);
    const results = await Promise.allSettled([a.acquire(), b.acquire()]);
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect([a.isHeld, b.isHeld].filter(Boolean)).toHaveLength(1);
    const owner = (await a.read())?.ownerId;
    expect(owner).toBe(a.isHeld ? "A" : "B");
  });

  it("leaves no temp or backup files next to the lock", async () => {
    const { store, make } = setup();
    const a = make("A");
    await a.acquire();
    await a.refresh();
    expect((await store.list("backup")).files).toEqual(["backup/lock.json"]);
  });
});
