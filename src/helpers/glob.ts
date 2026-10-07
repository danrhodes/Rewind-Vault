/**
 * Gitignore-style path matcher. Paths are vault-relative with "/" separators.
 *
 * - `*` matches within one segment, `?` one character, `**` any number of segments.
 * - A pattern without "/" matches at any depth (`*.tmp` matches `a/b/c.tmp`).
 * - A pattern with "/" (or a leading "/") is anchored to the vault root.
 * - A trailing "/" means "directory": it matches everything beneath it.
 * - A pattern also matches everything beneath a matched directory (`drafts` covers `drafts/a.md`).
 * - A leading "!" negates. The last matching pattern wins.
 */
export type PathMatcher = (path: string) => boolean;

interface Rule {
  negated: boolean;
  regex: RegExp;
}

function escapeChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? "\\" + ch : ch;
}

function globBody(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob.charAt(i + 1) === "*") {
      if (glob.charAt(i + 2) === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeChar(ch);
    }
  }
  return out;
}

function compile(pattern: string): Rule | null {
  let p = pattern.trim();
  if (p === "" || p.startsWith("#")) return null;
  const negated = p.startsWith("!");
  if (negated) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const rooted = p.startsWith("/");
  if (rooted) p = p.slice(1);
  if (p === "") return null;
  const anchored = rooted || p.includes("/");
  const prefix = anchored ? "" : "(?:.*/)?";
  const suffix = dirOnly ? "/.*" : "(?:/.*)?";
  return { negated, regex: new RegExp(`^${prefix}${globBody(p)}${suffix}$`) };
}

/** Returns true when the path is selected by the pattern list. */
export function createGlobMatcher(patterns: readonly string[]): PathMatcher {
  const rules = patterns.map(compile).filter((r): r is Rule => r !== null);
  return (path) => {
    let matched = false;
    for (const rule of rules) {
      if (rule.regex.test(path)) matched = !rule.negated;
    }
    return matched;
  };
}

/** True if any segment starts with "." (e.g. `.obsidian/app.json`, `notes/.hidden/a.md`). */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
}

/** True if `path` equals `folder` or is inside it. Both are vault-relative, no trailing slash. */
export function isInsideFolder(path: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  if (f === "") return true;
  return path === f || path.startsWith(`${f}/`);
}
