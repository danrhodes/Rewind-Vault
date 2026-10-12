let configDir = "";

/** The vault's config folder (`Vault#configDir`), set once by the plugin on load. */
export function setConfigDir(dir: string): void {
  configDir = dir;
}

export function getConfigDir(): string {
  return configDir;
}
