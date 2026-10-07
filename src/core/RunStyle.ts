import type { BackupStyle } from "../types";
import type { RunOptions } from "./BackupEngine";

/**
 * Turn the "automatic backup style" setting into engine options. `off` means no
 * automatic backup. Non-destructive runs build on the differential chain but never modify
 * or remove existing backups, and retention must skip them.
 */
export function runOptionsForStyle(style: BackupStyle): RunOptions | null {
  switch (style) {
    case "off":
      return null;
    case "full":
      return { mode: "full" };
    case "differential":
      return { mode: "diff" };
    case "non-destructive":
      return { mode: "diff", nonDestructive: true };
  }
}
