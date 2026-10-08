import { describe, expect, it } from "vitest";
import { PluginWatch, diffPluginVersions, readPluginVersions } from "../../src/core/PluginWatch";
import { MockLogger } from "../mocks/MockLogger";
import { MockVaultStore } from "../mocks/MockVaultStore";

const plugin = (store: MockVaultStore, id: string, version: string) =>
  store.seed(`.obsidian/plugins/${id}/manifest.json`, JSON.stringify({ id, version }));

function setup() {
  const store = new MockVaultStore();
  const watch = new PluginWatch({
    store,
    logger: new MockLogger(),
    configDir: ".obsidian",
    backupFolder: () => "backup",
    selfId: "rewind-vault",
  });
  return { store, watch };
}

describe("diffPluginVersions", () => {
  it("reports updated and new plugins, not removed or unchanged ones", () => {
    expect(
      diffPluginVersions({ a: "1.0.0", b: "1.0.0", gone: "1" }, { a: "1.1.0", b: "1.0.0", c: "2" }),
    ).toEqual([
      { id: "a", from: "1.0.0", to: "1.1.0" },
      { id: "c", from: null, to: "2" },
    ]);
  });
});

describe("readPluginVersions", () => {
  it("reads each manifest and skips unreadable ones", async () => {
    const { store } = setup();
    await plugin(store, "a", "1.0.0");
    await store.seed(".obsidian/plugins/broken/manifest.json", "{not json");
    await store.seed(".obsidian/plugins/empty/readme.md", "x");
    expect(await readPluginVersions(store, ".obsidian")).toEqual({ a: "1.0.0" });
  });

  it("gives nothing when there is no plugins folder", async () => {
    expect(await readPluginVersions(new MockVaultStore(), ".obsidian")).toEqual({});
  });
});

describe("PluginWatch", () => {
  it("records versions on the first check and reports no changes", async () => {
    const { store, watch } = setup();
    await plugin(store, "a", "1.0.0");
    expect(await watch.check()).toEqual([]);
    expect(await store.exists("backup/plugins.json")).toBe(true);
  });

  it("reports an update once, then nothing", async () => {
    const { store, watch } = setup();
    await plugin(store, "a", "1.0.0");
    await watch.check();
    await plugin(store, "a", "1.1.0");
    expect(await watch.check()).toEqual([{ id: "a", from: "1.0.0", to: "1.1.0" }]);
    expect(await watch.check()).toEqual([]);
  });

  it("reports a newly installed plugin", async () => {
    const { store, watch } = setup();
    await plugin(store, "a", "1.0.0");
    await watch.check();
    await plugin(store, "b", "0.1.0");
    expect(await watch.check()).toEqual([{ id: "b", from: null, to: "0.1.0" }]);
  });

  it("ignores this plugin's own updates", async () => {
    const { store, watch } = setup();
    await plugin(store, "rewind-vault", "0.0.1");
    await watch.check();
    await plugin(store, "rewind-vault", "0.0.2");
    expect(await watch.check()).toEqual([]);
  });

  it("treats a damaged record as a first run", async () => {
    const { store, watch } = setup();
    await plugin(store, "a", "1.0.0");
    await store.seed("backup/plugins.json", "garbage");
    expect(await watch.check()).toEqual([]);
    await plugin(store, "a", "2.0.0");
    expect(await watch.check()).toHaveLength(1);
  });
});
