import { Notice, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { PlatformKind, Settings, SettingsProfile } from "../types";
import {
  GROUPS,
  SETTINGS_SCHEMA,
  applyField,
  fieldsFor,
  getFieldValue,
  isFieldShown,
  type FieldDef,
} from "./schema";

/** What the tab needs from the plugin. Keeps the tab independent of main.ts. */
export interface SettingsHost {
  settings: Settings;
  platform: PlatformKind;
  save(): Promise<void>;
  /** Called after any setting changed and was saved, so triggers can re-read it. */
  onChanged?(): void;
}

/**
 * The settings screen. Everything shown comes from SETTINGS_SCHEMA (settings/schema.ts), which
 * is unit tested to cover every setting; this class only draws it and passes edits to
 * `applyField`. Each platform edits its own profile (desktop and mobile are separate), so a
 * vault synced between a computer and a phone keeps different settings on each.
 */
export class RewindVaultSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const profile = this.host.settings[this.host.platform];
    const label = this.host.platform === "mobile" ? "mobile" : "desktop";
    containerEl.createEl("p", {
      text: `These are the ${label} settings. Desktop and mobile keep separate settings.`,
      cls: "setting-item-description",
    });

    for (const group of GROUPS) {
      const fields = fieldsFor(group.key, this.host.platform);
      if (fields.length === 0) continue;
      new Setting(containerEl).setName(group.title).setDesc(group.blurb).setHeading();
      for (const def of fields) {
        if (isFieldShown(profile, def, this.host.platform))
          this.renderField(containerEl, profile, def);
      }
    }
  }

  private renderField(parent: HTMLElement, profile: SettingsProfile, def: FieldDef): void {
    const name = def.kind === "number" && def.unit ? `${def.name} (${def.unit})` : def.name;
    const setting = new Setting(parent).setName(name).setDesc(def.desc);
    const current = getFieldValue(profile, def);
    // Switches other fields depend on redraw the page so those fields appear or disappear.
    const dependedOn = SCHEMA_DEPENDENCIES.has(`${def.group}.${def.key}`);

    switch (def.kind) {
      case "toggle":
        setting.addToggle((t) =>
          t
            .setValue(current === true)
            .onChange((v) => void this.commit(profile, def, v, dependedOn)),
        );
        break;
      case "dropdown":
        setting.addDropdown((d) => {
          for (const o of def.options) d.addOption(o.value, o.label);
          d.setValue(String(current)).onChange(
            (v) => void this.commit(profile, def, v, dependedOn),
          );
        });
        break;
      case "number":
      case "text":
      case "password":
        setting.addText((t) => {
          if (def.kind === "password") t.inputEl.type = "password";
          if (def.kind === "number") t.inputEl.type = "number";
          if (def.kind !== "number" && def.placeholder) t.setPlaceholder(def.placeholder);
          t.setValue(String(current ?? ""));
          // Commit when the box loses focus or Enter is pressed, not on every keystroke, so a
          // half-typed number is never clamped under the user's fingers.
          t.inputEl.addEventListener("change", () => {
            void this.commit(profile, def, t.getValue(), false).then((shown) => {
              if (shown !== undefined) t.setValue(String(shown));
            });
          });
        });
        break;
      case "list":
        setting.addTextArea((t) => {
          if (def.placeholder) t.setPlaceholder(def.placeholder);
          t.setValue(Array.isArray(current) ? current.join("\n") : "");
          t.inputEl.addEventListener("change", () => {
            void this.commit(profile, def, t.getValue(), false).then((shown) => {
              if (Array.isArray(shown)) t.setValue(shown.join("\n"));
            });
          });
        });
        break;
    }
  }

  /** Validate, store and save. Returns the stored value, or undefined if it was rejected. */
  private async commit(
    profile: SettingsProfile,
    def: FieldDef,
    raw: unknown,
    redraw: boolean,
  ): Promise<unknown> {
    const result = applyField(profile, def, raw);
    if (!result.ok) {
      this.showError(def, result.message);
      return getFieldValue(profile, def);
    }
    await this.host.save();
    this.host.onChanged?.();
    if (redraw) this.display();
    return result.value;
  }

  private showError(def: FieldDef, message: string): void {
    new Notice(`${def.name}: ${message}`, 6000);
  }
}

/** Ids of settings that show or hide other fields. */
const SCHEMA_DEPENDENCIES: ReadonlySet<string> = new Set(
  SETTINGS_SCHEMA.flatMap((f) => (f.shownIf ? [`${f.group}.${f.shownIf.key}`] : [])),
);
