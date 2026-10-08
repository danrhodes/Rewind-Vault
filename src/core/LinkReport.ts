import { createYielder } from "../helpers/yieldToUI";
import type { IVaultStore } from "../storage/VaultStore";
import type { SettingsProfile } from "../types";
import { scanOptionsFromProfile, scanVault } from "./Scanner";

/** Notes read per scan at most; a bigger vault is reported as partial rather than freezing the app. */
export const MAX_NOTES_SCANNED = 20_000;
const SEPARATOR = "\u0000";

const WIKILINK = /!?\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;

/** Link targets in a note: `[[Note|alias#Heading]]`, `![[embed]]` and `[text](Note.md)`. External URLs are skipped. */
export function extractLinks(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const target = (match[1] ?? "").split("|")[0]?.split("#")[0]?.split("^")[0]?.trim();
    if (target) targets.push(target);
  }
  for (const match of text.matchAll(MDLINK)) {
    let raw = (match[1] ?? "").trim();
    if (raw.startsWith("<") && raw.includes(">")) raw = raw.slice(1, raw.indexOf(">"));
    else raw = raw.split(/\s+"/)[0] ?? raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw === "") continue;
    let target = raw.split("#")[0] ?? raw;
    try {
      target = decodeURIComponent(target);
    } catch {
      // keep the raw text
    }
    if (target.trim()) targets.push(target.trim());
  }
  return targets;
}

/** What links can point at: every path (with and without a `.md` ending) and every file name. */
export class LinkIndex {
  private readonly paths = new Set<string>();
  private readonly names = new Set<string>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      const lower = path.toLowerCase();
      const noExt = lower.endsWith(".md") ? lower.slice(0, -3) : lower;
      this.paths.add(lower);
      this.paths.add(noExt);
      const slash = lower.lastIndexOf("/");
      this.names.add(slash < 0 ? lower : lower.slice(slash + 1));
      const bare = slash < 0 ? noExt : noExt.slice(slash + 1);
      this.names.add(bare);
    }
  }

  /** Same matching as Obsidian: a path, or just a file name anywhere in the vault. Case-insensitive. */
  resolves(target: string): boolean {
    const clean = target.replace(/^\/+/, "").toLowerCase();
    return clean.includes("/") ? this.paths.has(clean) : this.names.has(clean);
  }
}

/** Keys of the form `source\0target` for every link that points at nothing. */
export function brokenLinks(notes: ReadonlyMap<string, string>, index: LinkIndex): Set<string> {
  const broken = new Set<string>();
  for (const [source, text] of notes) {
    for (const target of extractLinks(text)) {
      if (!index.resolves(target)) broken.add(`${source}${SEPARATOR}${target}`);
    }
  }
  return broken;
}

export interface LinkChange {
  source: string;
  target: string;
}

export interface LinkReport {
  /** Broken before the restore, working after it. */
  fixed: LinkChange[];
  /** Working before the restore, broken after it. */
  broken: LinkChange[];
  /** True when the vault was too big to read completely. */
  partial: boolean;
}

const toChange = (key: string): LinkChange => {
  const [source = "", target = ""] = key.split(SEPARATOR);
  return { source, target };
};

/** Compare the broken links before and after a restore. */
export function compareLinkStates(before: ReadonlySet<string>, after: ReadonlySet<string>) {
  return {
    fixed: [...before]
      .filter((k) => !after.has(k))
      .sort()
      .map(toChange),
    broken: [...after]
      .filter((k) => !before.has(k))
      .sort()
      .map(toChange),
  };
}

export function describeLinkReport(report: LinkReport): string {
  const parts: string[] = [];
  if (report.broken.length > 0) parts.push(`${report.broken.length} link(s) now broken`);
  if (report.fixed.length > 0) parts.push(`${report.fixed.length} link(s) fixed`);
  if (parts.length === 0) return "The restore did not change which links work.";
  return `${parts.join(", ")}.${report.partial ? " (Only part of the vault was checked.)" : ""}`;
}

export interface LinkScanState {
  broken: Set<string>;
  partial: boolean;
}

/** Reads the notes of the vault and finds links that point at nothing. */
export class LinkChecker {
  constructor(
    private readonly store: IVaultStore,
    private readonly getProfile: () => SettingsProfile,
  ) {}

  async scan(): Promise<LinkScanState> {
    const yieldIfNeeded = createYielder();
    const files = await scanVault(
      this.store,
      scanOptionsFromProfile(this.getProfile()),
      yieldIfNeeded,
    );
    const notes = new Map<string, string>();
    const decoder = new TextDecoder();
    let partial = false;
    for (const file of files) {
      if (!file.path.toLowerCase().endsWith(".md")) continue;
      if (notes.size >= MAX_NOTES_SCANNED) {
        partial = true;
        break;
      }
      try {
        notes.set(file.path, decoder.decode(await this.store.readBinary(file.path)));
      } catch {
        // A note that cannot be read is simply not checked.
      }
      await yieldIfNeeded();
    }
    return { broken: brokenLinks(notes, new LinkIndex(files.map((f) => f.path))), partial };
  }
}

export function buildLinkReport(before: LinkScanState, after: LinkScanState): LinkReport {
  return {
    ...compareLinkStates(before.broken, after.broken),
    partial: before.partial || after.partial,
  };
}
