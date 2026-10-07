import { BackupEngine, type EngineDeps } from "../../src/core/BackupEngine";
import { RestoreEngine, type RestoreDeps } from "../../src/core/RestoreEngine";
import type { CompletedResult, RunOptions } from "../../src/core/RunTypes";
import { createDefaultProfile } from "../../src/settings/defaults";
import type { SettingsProfile } from "../../src/types";
import { MockClock } from "../mocks/MockClock";
import { MockLogger } from "../mocks/MockLogger";
import { MockVaultStore } from "../mocks/MockVaultStore";

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Fast stand-in for PBKDF2 so most tests do not pay 600k iterations. */
export const fastMaster = async (salt: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", salt as BufferSource));

export interface Rig {
  store: MockVaultStore;
  clock: MockClock;
  profile: SettingsProfile;
  logger: MockLogger;
  engine: BackupEngine;
}

export function rig(
  tweak: (p: SettingsProfile) => void = () => undefined,
  deps: Partial<EngineDeps> = {},
): Rig {
  const clock = new MockClock(Date.UTC(2026, 9, 7, 21, 24, 0));
  const store = new MockVaultStore(clock);
  const profile = createDefaultProfile("desktop");
  tweak(profile);
  const logger = new MockLogger();
  const engine = new BackupEngine({
    store,
    logger,
    clock,
    getProfile: () => profile,
    platform: "desktop",
    pluginVersion: "0.0.1",
    deriveMasterKey: fastMaster,
    yieldIfNeeded: async () => undefined,
    lockOptions: { sleep: async () => undefined },
    ...deps,
  });
  return { store, clock, profile, logger, engine };
}

export async function seedVault(
  store: MockVaultStore,
  count: number,
): Promise<Map<string, Uint8Array>> {
  const originals = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const path = `folder${i % 20}/sub${i % 3}/note-${i}.md`;
    const data =
      i % 10 === 0
        ? Uint8Array.from({ length: 200 + (i % 50) }, (_, k) => (k * 7 + i) % 256)
        : enc(`# Note ${i}\n${"line of text ".repeat(i % 40)}\n`);
    await store.writeBinary(path, data);
    originals.set(path, data);
  }
  return originals;
}

/** Run a backup that is expected to complete, narrowing the result type. */
export async function runOk(engine: BackupEngine, options: RunOptions): Promise<CompletedResult> {
  const result = await engine.run(options);
  if (result.status !== "completed")
    throw new Error(`expected a completed backup, got ${result.status}`);
  return result;
}

/**
 * A RestoreEngine sharing the rig's store, clock, logger and profile. Its safety snapshot is a
 * real differential backup by the rig's BackupEngine; pass `extra` to replace any dependency.
 */
export function restoreEngineFor(r: Rig, extra: Partial<RestoreDeps> = {}): RestoreEngine {
  return new RestoreEngine({
    store: r.store,
    logger: r.logger,
    clock: r.clock,
    getProfile: () => r.profile,
    yieldIfNeeded: async () => undefined,
    safetySnapshot: async () => {
      const res = await r.engine.run({ mode: "diff" });
      return res.status === "completed" ? { backupId: res.backupId } : null;
    },
    ...extra,
  });
}
