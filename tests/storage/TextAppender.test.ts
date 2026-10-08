import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/helpers/errors";
import { createTextAppender, type AppendAdapterLike } from "../../src/storage/TextAppender";
import { readText } from "../../src/storage/VaultStore";
import { MockVaultStore } from "../mocks/MockVaultStore";

/** An adapter over the mock store with the real adapter's append semantics. */
function adapterOver(store: MockVaultStore, failOn?: "append" | "write"): AppendAdapterLike {
  return {
    exists: (p) => store.exists(p),
    async write(p, data) {
      if (failOn === "write") throw new Error("nope");
      await store.writeBinary(p, new TextEncoder().encode(data));
    },
    async append(p, data) {
      if (failOn === "append") throw new Error("nope");
      const old = await readText(store, p);
      await store.writeBinary(p, new TextEncoder().encode(old + data));
    },
  };
}

describe("createTextAppender", () => {
  it("creates the note and its folders when missing", async () => {
    const store = new MockVaultStore();
    const appender = createTextAppender(adapterOver(store), store);
    await appender.appendText("Journal/alerts.md", "one\n");
    expect(await readText(store, "Journal/alerts.md")).toBe("one\n");
  });

  it("appends to an existing note without touching what is there", async () => {
    const store = new MockVaultStore();
    await store.seed("alerts.md", "# Alerts\n");
    const appender = createTextAppender(adapterOver(store), store);
    await appender.appendText("alerts.md", "- two\n");
    expect(await readText(store, "alerts.md")).toBe("# Alerts\n- two\n");
  });

  it("reports failures as StorageError", async () => {
    const store = new MockVaultStore();
    await store.seed("a.md", "x");
    await expect(
      createTextAppender(adapterOver(store, "append"), store).appendText("a.md", "y"),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(
      createTextAppender(adapterOver(store, "write"), store).appendText("new.md", "y"),
    ).rejects.toBeInstanceOf(StorageError);
  });
});
