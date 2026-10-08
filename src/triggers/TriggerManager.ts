import type { IPlatform } from "../helpers/platform";
import { CloseTrigger, type CloseEvents } from "./CloseTrigger";
import { EventTrigger, type VaultEvents } from "./EventTrigger";
import { PreRiskTrigger, type PluginChecker } from "./PreRiskTrigger";
import { ResumeTrigger } from "./ResumeTrigger";
import { Scheduler, type DeepVerifyJob } from "./Scheduler";
import { StartupTrigger } from "./StartupTrigger";
import type { TimerHost, TriggerDeps } from "./TriggerTypes";

export interface TriggerManagerDeps {
  /** `run` here must be the RunGuard's request, so all triggers share one de-duplication. */
  triggers: TriggerDeps;
  platform: IPlatform;
  timers: TimerHost;
  events: VaultEvents;
  close: CloseEvents;
  /** Obsidian's `workspace.onLayoutReady`. */
  whenReady: (callback: () => void) => void;
  lastBackupAt: () => Promise<number | null>;
  deepVerify?: DeepVerifyJob;
  /** Reports installed or updated plugins; omit to snapshot only before bulk deletes/renames. */
  plugins?: PluginChecker;
}

/**
 * Owns every trigger: starts them when the plugin loads and stops them on unload. Only the
 * Scheduler needs a restart when settings change; the others read settings live (and restarting
 * the startup trigger would fire it again).
 */
export class TriggerManager {
  private readonly startup: StartupTrigger;
  private readonly scheduler: Scheduler;
  private readonly resume: ResumeTrigger;
  private readonly events: EventTrigger;
  private readonly close: CloseTrigger;
  private readonly preRisk: PreRiskTrigger;
  private started = false;

  constructor(private readonly deps: TriggerManagerDeps) {
    const { triggers, platform, timers } = deps;
    this.startup = new StartupTrigger(triggers, timers);
    this.scheduler = new Scheduler(triggers, timers, deps.deepVerify);
    this.resume = new ResumeTrigger(triggers, platform, { lastBackupAt: deps.lastBackupAt });
    this.events = new EventTrigger(triggers, timers, deps.events);
    this.close = new CloseTrigger(triggers, platform, deps.close);
    this.preRisk = new PreRiskTrigger(triggers, timers, deps.events, deps.plugins ?? null);
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    this.started = true;
    this.startup.start(this.deps.whenReady);
    this.scheduler.start();
    this.resume.start();
    this.events.start();
    this.close.start();
    this.preRisk.start(this.deps.whenReady);
  }

  /** Call after settings change: re-reads interval, daily times and deep verify. */
  reconfigure(): void {
    if (this.started) this.scheduler.reconfigure();
  }

  stop(): void {
    this.started = false;
    this.startup.stop();
    this.scheduler.stop();
    this.resume.stop();
    this.events.stop();
    this.close.stop();
    this.preRisk.stop();
  }
}
