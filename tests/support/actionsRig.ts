import { Actions, type ProgressHandle } from "../../src/commands/actions";
import { verifyAndRecord } from "../../src/core/VerifyRunner";
import type { RunProgress } from "../../src/core/RunTypes";
import { Notifier } from "../../src/ui/notify";
import type { CancelSource } from "../../src/ui/progressModel";
import type { VerifyReport } from "../../src/types";
import { fastMaster, rig, type Rig } from "./engineRig";

export interface Harness {
  r: Rig;
  actions: Actions;
  notices: string[];
  opened: { title: string; cancel: CancelSource; updates: RunProgress[]; closed: boolean }[];
  reports: VerifyReport[];
}

export function harness(
  tweak: (r: Rig) => void = () => undefined,
  level: "verbose" | "errors" = "verbose",
) {
  const r = rig((p) => {
    p.notifications.level = level;
  });
  tweak(r);
  const notices: string[] = [];
  const opened: Harness["opened"] = [];
  const reports: VerifyReport[] = [];
  const getProfile = () => r.profile;
  const actions = new Actions({
    store: r.store,
    logger: r.logger,
    backup: r.engine,
    verifyBackup: (id, options) =>
      verifyAndRecord(
        {
          store: r.store,
          logger: r.logger,
          clock: r.clock,
          getProfile,
          platform: "desktop",
          deriveMasterKey: fastMaster,
          lockOptions: { sleep: async () => undefined },
        },
        id,
        options,
      ),
    notifier: new Notifier((m) => notices.push(m), getProfile),
    getProfile,
    progress: {
      open(title, cancel) {
        const record = { title, cancel, updates: [] as RunProgress[], closed: false };
        opened.push(record);
        const handle: ProgressHandle = {
          updateBackup: (p) => record.updates.push(p),
          updateRestore: () => undefined,
          close: () => {
            record.closed = true;
          },
        };
        return handle;
      },
    },
    results: { showVerifyReport: (rep) => reports.push(rep) },
  });
  return { r, actions, notices, opened, reports } as Harness;
}

export async function seed(r: Rig): Promise<void> {
  await r.store.seed("a.md", "alpha");
  await r.store.seed("b.md", "beta");
}

export const joined = (h: Harness): string => h.notices.join(" | ");
