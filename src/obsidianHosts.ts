import type { App, Plugin } from "obsidian";
import type { CloseEvents } from "./triggers/CloseTrigger";
import type { VaultEvents } from "./triggers/EventTrigger";
import type { TimerHost } from "./triggers/TriggerTypes";
import type { StatusBarItem } from "./ui/StatusBar";

/** Timers that Obsidian clears on unload (`registerInterval`); one-shot timers are cleared by the triggers. */
export function createTimerHost(plugin: Plugin): TimerHost {
  return {
    setInterval: (callback, ms) => plugin.registerInterval(window.setInterval(callback, ms)),
    clearInterval: (handle) => window.clearInterval(handle),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
  };
}

/** Vault change notifications as plain paths. */
export function createVaultEvents(app: App): VaultEvents {
  const { vault } = app;
  return {
    on(kind, callback) {
      const ref =
        kind === "modify"
          ? vault.on("modify", (f) => callback(f.path))
          : kind === "create"
            ? vault.on("create", (f) => callback(f.path))
            : kind === "delete"
              ? vault.on("delete", (f) => callback(f.path))
              : vault.on("rename", (f) => callback(f.path));
      return () => vault.offref(ref);
    },
  };
}

export function createCloseEvents(): CloseEvents {
  return {
    onBeforeClose(callback) {
      window.addEventListener("beforeunload", callback);
      return () => window.removeEventListener("beforeunload", callback);
    },
  };
}

export function createStatusBarItem(plugin: Plugin): StatusBarItem {
  const el = plugin.addStatusBarItem();
  return { setText: (text) => void el.setText(text), remove: () => el.remove() };
}
