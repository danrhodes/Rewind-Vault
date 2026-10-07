import { Plugin } from "obsidian";

export default class RewindVaultPlugin extends Plugin {
  override onload(): void {
    // Lifecycle only: settings, services, triggers, commands and UI are wired in later tasks.
  }

  override onunload(): void {
    // Cleanup of registered resources is added alongside the code that creates them.
  }
}
