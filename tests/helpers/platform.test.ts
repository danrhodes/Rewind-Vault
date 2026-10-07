import { describe, expect, it } from "vitest";
import { createPlatform } from "../../src/helpers/platform";
import { MockPlatform } from "../mocks/MockPlatform";

function fakeDoc(state: "visible" | "hidden" = "visible") {
  const handlers = new Set<() => void>();
  const doc = {
    visibilityState: state as string,
    addEventListener: (_t: string, h: () => void) => void handlers.add(h),
    removeEventListener: (_t: string, h: () => void) => void handlers.delete(h),
  };
  return { doc, handlers, fire: () => handlers.forEach((h) => h()) };
}

describe("createPlatform", () => {
  it("derives kind from flags", () => {
    expect(createPlatform({ isMobile: true, isDesktop: false }).kind).toBe("mobile");
    expect(createPlatform({ isMobile: false, isDesktop: true }).kind).toBe("desktop");
  });

  it("reports battery as a percentage, or null when unsupported or failing", async () => {
    const ok = createPlatform({
      isMobile: true,
      isDesktop: false,
      getBatteryManager: async () => ({ level: 0.256, charging: true }),
    });
    expect(await ok.getBattery()).toEqual({ level: 26, charging: true });

    const failing = createPlatform({
      isMobile: true,
      isDesktop: false,
      getBatteryManager: async () => {
        throw new Error("denied");
      },
    });
    expect(await failing.getBattery()).toBeNull();
    expect(await createPlatform({ isMobile: false, isDesktop: true }).getBattery()).toBeNull();
  });

  it("tracks visibility and unsubscribes", () => {
    const f = fakeDoc("visible");
    const p = createPlatform({ isMobile: false, isDesktop: true, doc: f.doc });
    const seen: boolean[] = [];
    const off = p.onVisibilityChange((v) => seen.push(v));
    expect(p.isVisible()).toBe(true);
    f.doc.visibilityState = "hidden";
    f.fire();
    expect(p.isVisible()).toBe(false);
    off();
    f.doc.visibilityState = "visible";
    f.fire();
    expect(seen).toEqual([false]);
    expect(f.handlers.size).toBe(0);
  });
});

describe("MockPlatform", () => {
  it("is controllable", async () => {
    const m = new MockPlatform("mobile");
    m.battery = { level: 10, charging: false };
    const seen: boolean[] = [];
    const off = m.onVisibilityChange((v) => seen.push(v));
    m.setVisible(false);
    off();
    m.setVisible(true);
    expect(seen).toEqual([false]);
    expect(await m.getBattery()).toEqual({ level: 10, charging: false });
    expect(m.isMobile && !m.isDesktop).toBe(true);
    expect(m.listenerCount).toBe(0);
  });
});
