import { describe, expect, it } from "vitest";
import { AdapterVaultStore, readText, type IVaultStore } from "../../src/storage/VaultStore";
import { StorageError } from "../../src/helpers/errors";
import { FakeAdapter } from "../mocks/FakeAdapter";
import { MockClock } from "../mocks/MockClock";
import { MockVaultStore } from "../mocks/MockVaultStore";

const impls: [string, () => IVaultStore][] = [
  ["MockVaultStore", () => new MockVaultStore(new MockClock())],
  ["AdapterVaultStore(FakeAdapter)", () => new AdapterVaultStore(new FakeAdapter())],
];

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe.each(impls)("IVaultStore contract: %s", (_name, make) => {
  it("write creates parents; read returns identical bytes; reads are copies", async () => {
    const s = make();
    await s.writeBinary("a/b/c.bin", bytes(1, 2, 3));
    expect(await s.exists("a/b")).toBe(true);
    const out = await s.readBinary("a/b/c.bin");
    expect(Array.from(out)).toEqual([1, 2, 3]);
    out[0] = 99;
    expect(Array.from(await s.readBinary("a/b/c.bin"))).toEqual([1, 2, 3]);
  });

  it("write does not alias the caller buffer", async () => {
    const s = make();
    const data = bytes(1, 2);
    await s.writeBinary("x.bin", data);
    data[0] = 9;
    expect(Array.from(await s.readBinary("x.bin"))).toEqual([1, 2]);
  });

  it("stat reports type and size, null when missing", async () => {
    const s = make();
    await s.writeBinary("d/f.bin", bytes(1, 2, 3, 4));
    expect(await s.stat("d/f.bin")).toMatchObject({ type: "file", size: 4 });
    expect(await s.stat("d")).toMatchObject({ type: "folder" });
    expect(await s.stat("nope")).toBeNull();
  });

  it("mkdir is recursive and idempotent", async () => {
    const s = make();
    await s.mkdir("p/q/r");
    await s.mkdir("p/q/r");
    expect(await s.exists("p/q")).toBe(true);
  });

  it("list returns immediate children only, sorted", async () => {
    const s = make();
    await s.writeBinary("top/b.md", bytes(1));
    await s.writeBinary("top/a.md", bytes(1));
    await s.writeBinary("top/sub/deep.md", bytes(1));
    await s.writeBinary("other.md", bytes(1));
    expect(await s.list("top")).toEqual({
      files: ["top/a.md", "top/b.md"],
      folders: ["top/sub"],
    });
    const root = await s.list("");
    expect(root.files).toEqual(["other.md"]);
    expect(root.folders).toEqual(["top"]);
  });

  it("rename moves a file, fails if destination exists, creates destination parents", async () => {
    const s = make();
    await s.writeBinary("a.md", bytes(1));
    await s.writeBinary("b.md", bytes(2));
    await expect(s.rename("a.md", "b.md")).rejects.toThrow();
    expect(Array.from(await s.readBinary("b.md"))).toEqual([2]);
    await s.rename("a.md", "new/dir/a.md");
    expect(await s.exists("a.md")).toBe(false);
    expect(Array.from(await s.readBinary("new/dir/a.md"))).toEqual([1]);
  });

  it("remove deletes a file; removeFolder deletes recursively", async () => {
    const s = make();
    await s.writeBinary("f/1.md", bytes(1));
    await s.writeBinary("f/g/2.md", bytes(1));
    await s.remove("f/1.md");
    expect(await s.exists("f/1.md")).toBe(false);
    await s.removeFolder("f");
    expect(await s.exists("f")).toBe(false);
    expect(await s.exists("f/g/2.md")).toBe(false);
  });

  it("readText decodes UTF-8", async () => {
    const s = make();
    await s.writeBinary("t.txt", new TextEncoder().encode("héllo"));
    expect(await readText(s, "t.txt")).toBe("héllo");
  });
});

describe("AdapterVaultStore error wrapping", () => {
  it("wraps adapter failures in StorageError with the path and cause", async () => {
    const s = new AdapterVaultStore(new FakeAdapter());
    const err = await s.readBinary("missing.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).path).toBe("missing.md");
    expect((err as StorageError).cause).toBeInstanceOf(Error);
  });
});
