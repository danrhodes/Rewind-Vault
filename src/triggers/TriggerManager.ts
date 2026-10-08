import type { IPlatform } from "../helpers/platform";
import { CloseTrigger, type CloseEvents } from "./CloseTrigger";
import { EditVolumeTrigger, type NoteReader } from "./EditVolumeTrigger";
import { EventTrigger, type VaultEvents } from "./EventTrigger";
import { LowBatteryTrigger } from "./LowBatteryTrigger";
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
  /** Reads a note for the word-count trigger; omit to leave that trigger out. */
  readNote?: NoteReader;
  /** Scheduled restore rehearsal. */
  rehearsal?: DeepVerifyJob;
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
  private readonly editVolume: EditVolumeTrigger | null;
  private readonly preRisk: PreRiskTrigger;
  private readonly lowBattery: LowBatteryTrigger;
  private started = false;

  constructor(private readonly deps: TriggerManagerDeps) {
    const { triggers, platform, timers } = deps;
    this.startup = new StartupTrigger(triggers, timers);
    this.scheduler = new Scheduler(triggers, timers, deps.deepVerify, deps.rehearsal);
    this.resume = new ResumeTrigger(triggers, platform, { lastBackupAt: deps.lastBackupAt });
    this.events = new EventTrigger(triggers, timers, deps.events);
    this.close = new CloseTrigger(triggers, platform, deps.close);
    this.editVolume = deps.readNote
      ? new EditVolumeTrigger(triggers, timers, deps.events, deps.readNote)
      : null;
    this.lowBattery = new LowBatteryTrigger(triggers, timers, platform);
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
    this.editVolume?.start();
    this.close.start();
    this.preRisk.start(this.deps.whenReady);
    this.lowBattery.start();
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
    this.editVolume?.stop();
    this.close.stop();
    this.preRisk.stop();
    this.lowBattery.stop();
  }
}
