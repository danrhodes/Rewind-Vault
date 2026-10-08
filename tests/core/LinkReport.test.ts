import { describe, expect, it } from "vitest";
import {
  LinkChecker,
  LinkIndex,
  brokenLinks,
  buildLinkReport,
  compareLinkStates,
  describeLinkReport,
  extractLinks,
} from "../../src/core/LinkReport";
import { createDefaultProfile } from "../../src/settings/defaults";
import { MockVaultStore } from "../mocks/MockVaultStore";

describe("extractLinks", () => {
  it("finds wikilinks, dropping alias, heading and block parts", () => {
    expect(
      extractLinks(
        "See [[Alpha]], [[Beta|the beta]], [[Gamma#Part]], [[Delta^abc]], ![[pic.png]].",
      ),
    ).toEqual(["Alpha", "Beta", "Gamma", "Delta", "pic.png"]);
  });

  it("finds markdown links, decodes them and skips URLs and anchors", () => {
    expect(
      extractLinks(
        '[a](Notes/My%20Note.md) [b](https://example.com) [c](#top) [d](<Has Space.md>) [e](x.md "title") [f](mailto:a@b.c)',
      ),
    ).toEqual(["Notes/My Note.md", "Has Space.md", "x.md"]);
  });

  it("ignores empty links", () => {
    expect(extractLinks("[[]] [[ | ]] [x]()")).toEqual([]);
  });
});

describe("LinkIndex", () => {
  const index = new LinkIndex(["Notes/Alpha.md", "Beta.md", "img/Pic.PNG"]);

  it("resolves a bare name anywhere in the vault, with or without .md, ignoring case", () => {
    expect(index.resolves("alpha")).toBe(true);
    expect(index.resolves("Alpha.md")).toBe(true);
    expect(index.resolves("BETA")).toBe(true);
    expect(index.resolves("pic.png")).toBe(true);
    expect(index.resolves("Gamma")).toBe(false);
  });

  it("resolves a path only when the whole path matches", () => {
    expect(index.resolves("Notes/Alpha")).toBe(true);
    expect(index.resolves("/Notes/Alpha.md")).toBe(true);
    expect(index.resolves("Other/Alpha")).toBe(false);
  });
});

describe("brokenLinks and compare", () => {
  const notes = new Map([
    ["a.md", "[[b]] [[missing]]"],
    ["b.md", "[[a]] [[also missing]]"],
  ]);
  const index = new LinkIndex(["a.md", "b.md"]);

  it("lists only links that point at nothing, per source note", () => {
    expect([...brokenLinks(notes, index)].map((k) => k.replace("\u0000", " -> ")).sort()).toEqual([
      "a.md -> missing",
      "b.md -> also missing",
    ]);
  });

  it("splits changes into fixed and newly broken", () => {
    const before = new Set(["a.md\u0000x", "a.md\u0000y"]);
    const after = new Set(["a.md\u0000y", "b.md\u0000z"]);
    expect(compareLinkStates(before, after)).toEqual({
      fixed: [{ source: "a.md", target: "x" }],
      broken: [{ source: "b.md", target: "z" }],
    });
  });
});

describe("describeLinkReport", () => {
  it("summarises each case", () => {
    const base = { fixed: [], broken: [], partial: false };
    expect(describeLinkReport(base)).toBe("The restore did not change which links work.");
    expect(describeLinkReport({ ...base, fixed: [{ source: "a", target: "b" }] })).toBe(
      "1 link(s) fixed.",
    );
    expect(
      describeLinkReport({
        fixed: [{ source: "a", target: "b" }],
        broken: [{ source: "c", target: "d" }],
        partial: true,
      }),
    ).toBe("1 link(s) now broken, 1 link(s) fixed. (Only part of the vault was checked.)");
  });
});

describe("LinkChecker", () => {
  const profile = createDefaultProfile("desktop");

  async function vault(files: Record<string, string>) {
    const store = new MockVaultStore();
    for (const [p, t] of Object.entries(files)) await store.seed(p, t);
    return store;
  }

  it("reports a restore that fixes one link and breaks another", async () => {
    const store = await vault({ "a.md": "[[gone]] [[kept]]", "kept.md": "k", "gone.md": "g" });
    const checker = new LinkChecker(store, () => profile);
    const before = await checker.scan();
    expect(before.broken.size).toBe(0);
    await store.remove("gone.md"); // breaks a.md -> gone
    await store.seed("later.md", "[[new]]"); // already broken before? no: new note
    await store.seed("new.md", "n");
    const middle = await checker.scan();
    expect(middle.broken.size).toBe(1);
    await store.seed("gone.md", "back"); // restore brings it back, removes "kept"
    await store.remove("kept.md");
    const after = await checker.scan();
    const report = buildLinkReport(middle, after);
    expect(report.fixed).toEqual([{ source: "a.md", target: "gone" }]);
    expect(report.broken).toEqual([{ source: "a.md", target: "kept" }]);
    expect(report.partial).toBe(false);
  });

  it("only reads markdown notes and skips the backup folder", async () => {
    const store = await vault({
      "a.md": "[[missing]]",
      "data.json": "[[not a note]]",
      "backup/x/old.md": "[[ignored]]",
    });
    const scan = await new LinkChecker(store, () => profile).scan();
    expect([...scan.broken]).toEqual(["a.md\u0000missing"]);
  });
});
