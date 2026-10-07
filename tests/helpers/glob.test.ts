import { describe, expect, it } from "vitest";
import { createGlobMatcher, isHiddenPath, isInsideFolder } from "../../src/helpers/glob";

describe("createGlobMatcher", () => {
  it("* stays within a segment", () => {
    const m = createGlobMatcher(["notes/*.md"]);
    expect(m("notes/a.md")).toBe(true);
    expect(m("notes/sub/a.md")).toBe(false);
    expect(m("other/a.md")).toBe(false);
  });

  it("unanchored patterns match at any depth", () => {
    const m = createGlobMatcher(["*.tmp"]);
    expect(m("a.tmp")).toBe(true);
    expect(m("x/y/z.tmp")).toBe(true);
    expect(m("x/y/z.txt")).toBe(false);
  });

  it("** crosses segments", () => {
    const m = createGlobMatcher(["attachments/**/*.png"]);
    expect(m("attachments/a.png")).toBe(true);
    expect(m("attachments/x/y/a.png")).toBe(true);
    expect(m("attachments/x/a.jpg")).toBe(false);
    expect(createGlobMatcher(["**/draft.md"])("a/b/draft.md")).toBe(true);
    expect(createGlobMatcher(["**/draft.md"])("draft.md")).toBe(true);
  });

  it("a matched folder covers its contents, trailing slash is directory-only", () => {
    const m = createGlobMatcher(["drafts"]);
    expect(m("drafts")).toBe(true);
    expect(m("drafts/a.md")).toBe(true);
    expect(m("drafts2/a.md")).toBe(false);
    const d = createGlobMatcher(["drafts/"]);
    expect(d("drafts/a.md")).toBe(true);
    expect(d("drafts")).toBe(false);
  });

  it("leading slash anchors to the root", () => {
    const m = createGlobMatcher(["/temp"]);
    expect(m("temp/a.md")).toBe(true);
    expect(m("x/temp/a.md")).toBe(false);
  });

  it("? matches exactly one non-slash character", () => {
    const m = createGlobMatcher(["a?.md"]);
    expect(m("ab.md")).toBe(true);
    expect(m("a.md")).toBe(false);
    expect(m("abc.md")).toBe(false);
  });

  it("negation re-includes, last match wins", () => {
    const m = createGlobMatcher(["archive/**", "!archive/keep.md"]);
    expect(m("archive/old.md")).toBe(true);
    expect(m("archive/keep.md")).toBe(false);
    const flipped = createGlobMatcher(["!archive/keep.md", "archive/**"]);
    expect(flipped("archive/keep.md")).toBe(true);
  });

  it("escapes regex characters and ignores blanks and comments", () => {
    const m = createGlobMatcher(["", "# note", "a+b(1).md"]);
    expect(m("a+b(1).md")).toBe(true);
    expect(m("aab(1).md")).toBe(false);
    expect(createGlobMatcher([])("anything")).toBe(false);
  });

  it("matches hidden directories when named explicitly", () => {
    const m = createGlobMatcher([".git", ".trash/"]);
    expect(m(".git/config")).toBe(true);
    expect(m("sub/.git/config")).toBe(true);
    expect(m(".trash/old.md")).toBe(true);
  });
});

describe("isHiddenPath", () => {
  it("detects dot segments anywhere", () => {
    expect(isHiddenPath(".obsidian/app.json")).toBe(true);
    expect(isHiddenPath("notes/.hidden/a.md")).toBe(true);
    expect(isHiddenPath("notes/.env")).toBe(true);
    expect(isHiddenPath("notes/a.md")).toBe(false);
    expect(isHiddenPath("notes/file.with.dots.md")).toBe(false);
  });
});

describe("isInsideFolder", () => {
  it("handles equality, nesting and slash noise", () => {
    expect(isInsideFolder("backup/index.json", "backup")).toBe(true);
    expect(isInsideFolder("backup", "backup/")).toBe(true);
    expect(isInsideFolder("backup2/a.md", "backup")).toBe(false);
    expect(isInsideFolder("a.md", "")).toBe(true);
    expect(isInsideFolder("x/backup/a.md", "backup")).toBe(false);
  });
});
