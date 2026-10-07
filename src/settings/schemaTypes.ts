import type { SettingsProfile } from "../types";

export type GroupKey = keyof SettingsProfile;

/** Display order and headings of the settings tab: one section per PLAN section 7 group. */
export const GROUPS: readonly { key: GroupKey; title: string; blurb: string }[] = [
  { key: "basic", title: "Basic", blurb: "When and how backups start." },
  { key: "destination", title: "Destination", blurb: "Where backups and restores go." },
  { key: "zip", title: "ZIP", blurb: "How backups are split and compressed." },
  { key: "triggers", title: "Triggers", blurb: "What starts an automatic backup." },
  { key: "conditions", title: "Conditions", blurb: "When an automatic backup is allowed to run." },
  { key: "exclusions", title: "Exclusions", blurb: "What is left out of backups." },
  { key: "retention", title: "Retention", blurb: "How many old backups are kept." },
  { key: "encryption", title: "Encryption", blurb: "Protect backups with a passphrase." },
  { key: "verification", title: "Verification", blurb: "Check that backups can be restored." },
  { key: "safety", title: "Safety", blurb: "Guards against accidents and bad changes." },
  { key: "notifications", title: "Notifications", blurb: "Messages, status bar and log." },
  { key: "misc", title: "Misc", blurb: "Advanced options." },
];

interface FieldBase {
  group: GroupKey;
  /** Key inside the group. */
  key: string;
  name: string;
  desc: string;
  /** Hidden on mobile (the platform cannot do it). */
  desktopOnly?: boolean;
  /** Shown only while another setting of the same group has this value. */
  shownIf?: { key: string; value: boolean | string };
}

export interface ToggleField extends FieldBase {
  kind: "toggle";
}

export interface NumberField extends FieldBase {
  kind: "number";
  min: number;
  max: number;
  /** Shown after the box, e.g. "minutes". */
  unit?: string;
  /** Default true. Values are rounded to whole numbers. */
  integer?: boolean;
}

export interface TextField extends FieldBase {
  kind: "text" | "password";
  placeholder?: string;
  /** "folder": a vault-relative folder (no leading slash, no ..). Empty is rejected. */
  validate?: "folder";
}

export interface DropdownField extends FieldBase {
  kind: "dropdown";
  options: readonly { value: string; label: string }[];
}

export interface ListField extends FieldBase {
  kind: "list";
  placeholder?: string;
  /** "time": every line must be HH:MM (24 hour). */
  validate?: "time";
}

export type FieldDef = ToggleField | NumberField | TextField | DropdownField | ListField;

/**
 * Settings that exist in the data model but are deliberately not in the tab, with the reason.
 * `linked` ones are controlled through another field.
 */
export const LINKED: Readonly<Record<string, string>> = {
  "triggers.onStartup": "basic.backupOnStartup",
};
export const DEFERRED: Readonly<Record<string, string>> = {
  "misc.settingsPassphraseEnabled": "T-110 (settings passphrase protection)",
};

export const fieldId = (def: { group: string; key: string }): string => `${def.group}.${def.key}`;
