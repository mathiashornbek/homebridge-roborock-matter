import { PlatformAccessory } from "homebridge";
import RoborockPlatform from "./platform";
import {
  CloudScene,
  CLOUD_SCENE_ID_PREFIX,
  cloudSceneIdFromScheduleId,
  cloudSceneSwitchPosition,
  executeCloudScene,
  getCloudScenes,
  getServerTimers,
  isCloudSceneScheduleId,
  setCloudSceneScheduleEnabled,
  updateServerTimer,
  updateTimer,
} from "./hap_schedule_api";
import { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME } from "./settings";
import { clearTimer, scheduleTimer, unrefTimer } from "./timers";

const VERIFY_DELAY_MS = 3000;
const WRITE_SUPPRESSION_MS = 5000;
// WHY FIVE MINUTES, IN THE AUTHOR'S OWN WORDS. Recorded here rather than left
// in the pull request, because the next person to look at this number will
// look at this line and not at #23.
//
// pponce, who contributed the cache in 3.22.0, settled on 5 minutes for these
// reasons:
//
//   * HomeKit reads characteristics far more often than schedules change.
//   * A cloud request per read would multiply traffic across every switch and
//     every vacuum on the account.
//   * A schedule changed in HomeKit does NOT wait for this TTL — the write
//     path performs its own authoritative verification.
//   * So the only staleness this bounds is a change made externally, in the
//     Roborock app.
//   * Five minutes bounds that case while sharply cutting steady-state cloud
//     traffic.
//
// The fourth point is the one worth keeping: this TTL is not "how stale may a
// schedule switch be", it is "how stale may a switch be after a change this
// bridge had no way to observe". Reasoning about it as a bound on all schedule
// changes overstates the cost considerably.
//
// A user-configurable setting was considered and deliberately not added: the
// real axis is how much a given user drives schedules from the Roborock app
// versus from HomeKit, nobody has yet reported the default as wrong, and a
// setting in this plugin costs four places to keep in sync permanently. This
// constant can become a setting in an afternoon; a setting cannot be withdrawn.
const SCHEDULE_CACHE_TTL_MS = 5 * 60 * 1000;
const SCHEDULE_FAILURE_BACKOFF_STEPS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
] as const;
const SCHEDULE_FAILURE_JITTER_RATIO = 0.1;
const SCHEDULE_WRITE_BATCH_WINDOW_MS = 500;
const SCHEDULE_WRITE_SPACING_MS = 500;
const SCHEDULE_THROTTLE_COOLDOWN_MS = 65 * 60 * 1000;
const SERVICE_PREFIX = "roborock-schedule-";
const ROUTINE_SERVICE_PREFIX = "roborock-routine-";
// A routine switch is momentary: the press is the command. Same reasoning and
// the same 1.5 s as the action switches — long enough for the Home app to draw
// the press and an automation to record it, short enough to be ready again.
const ROUTINE_SWITCH_AUTO_RESET_MS = 1500;

/**
 * Where a schedule lives, because two kinds now share the switch surface.
 *
 * `serverTimer` is the device-side list (`get_server_timer`), the only kind
 * this accessory knew until 3.28. `cloudScene` is a timer-driven Routine on
 * the account (`user/scene/device/{duid}`), which is where robots that refuse
 * the device-side list — the Saros 10R in #22 answers `-10007 "Not FCC
 * robot"` — keep every schedule their owner sees in the app.
 */
export type ScheduleSource = "serverTimer" | "cloudScene";

/**
 * How a robot's refusal of `get_server_timer` is recognised.
 *
 * `-10007` is the code, `Not FCC robot` the message, and "refuses" the word
 * the shared API puts in front of both. A robot that answers this way will
 * answer it again every time, so once seen the device-side source is not
 * asked again this session and its absence stops counting as a failure.
 */
const SERVER_TIMER_REFUSAL_PATTERN =
  /-10007|Not FCC robot|refuses get_server_timer/i;

export function isServerTimerRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SERVER_TIMER_REFUSAL_PATTERN.test(message);
}

export interface SchedulePolicyOptions {
  cacheTtlMs: number;
  batchWindowMs: number;
  writeSpacingMs: number;
  throttleCooldownMs: number;
}

export const DEFAULT_SCHEDULE_POLICY: Readonly<SchedulePolicyOptions> = {
  cacheTtlMs: SCHEDULE_CACHE_TTL_MS,
  batchWindowMs: SCHEDULE_WRITE_BATCH_WINDOW_MS,
  writeSpacingMs: SCHEDULE_WRITE_SPACING_MS,
  throttleCooldownMs: SCHEDULE_THROTTLE_COOLDOWN_MS,
};

export const HAP_EXTENSION_KIND = "hapExtension" as const;
export const HAP_SCHEDULE_EXTENSION = "schedules" as const;

export function scheduleFailureBackoffMs(
  consecutiveFailures: number,
  randomValue = Math.random()
): number {
  const failureIndex = Math.max(0, Math.floor(consecutiveFailures) - 1);
  const baseDelay =
    SCHEDULE_FAILURE_BACKOFF_STEPS_MS[
      Math.min(failureIndex, SCHEDULE_FAILURE_BACKOFF_STEPS_MS.length - 1)
    ];
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const jitterFactor =
    1 + (boundedRandom * 2 - 1) * SCHEDULE_FAILURE_JITTER_RATIO;

  return Math.round(baseDelay * jitterFactor);
}

export function isDefiniteScheduleThrottle(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const visited = new Set<unknown>();

  while (candidates.length > 0) {
    const candidate = candidates.shift();
    if (candidate == null || visited.has(candidate)) continue;
    visited.add(candidate);

    if (typeof candidate === "number" && candidate === 429) return true;

    if (typeof candidate === "string") {
      if (
        /\b429\b|too many requests|rate[ -]?limit(?:ed|ing)?|request limit|frequency limit|throttl(?:ed|ing)/i.test(
          candidate
        )
      ) {
        return true;
      }
      continue;
    }

    if (typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    candidates.push(
      record.status,
      record.statusCode,
      record.code,
      record.message,
      record.cause,
      record.response
    );
  }

  return false;
}

export class ScheduleWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  enqueue<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const generation = this.generation;
    const run = this.tail.then(async () => {
      if (generation !== this.generation) {
        return undefined;
      }

      return operation();
    });

    this.tail = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  cancelPending(): void {
    this.generation++;
  }
}

export class ScheduleAccountCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private throttleUntil = 0;
  private throttleError: unknown;
  private readonly metrics = {
    scheduleReads: 0,
    primaryWrites: 0,
    fallbackWrites: 0,
    coalescedChanges: 0,
    cacheAvoidedReads: 0,
    backoffAvoidedReads: 0,
    throttleAvoidedOperations: 0,
  };

  constructor(
    public readonly policy: Readonly<SchedulePolicyOptions> = DEFAULT_SCHEDULE_POLICY
  ) {}

  enqueue<T>(
    operation: () => Promise<T>,
    rejectedDuringCooldown: (error: unknown) => T
  ): Promise<T> {
    const run = this.tail.then(async () => {
      const throttle = this.currentThrottleError();
      if (throttle !== undefined) {
        this.metrics.throttleAvoidedOperations++;
        return rejectedDuringCooldown(throttle);
      }
      return operation();
    });

    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  recordThrottle(error: unknown): void {
    this.throttleUntil = Math.max(
      this.throttleUntil,
      Date.now() + this.policy.throttleCooldownMs
    );
    this.throttleError = error;
  }

  currentThrottleError(now = Date.now()): unknown {
    if (this.throttleUntil <= now) return undefined;
    return (
      this.throttleError ??
      new Error("Roborock schedule requests are in throttle cooldown")
    );
  }

  cooldownRemainingMs(now = Date.now()): number {
    return Math.max(0, this.throttleUntil - now);
  }

  recordRequest(kind: "read" | "primaryWrite" | "fallbackWrite"): void {
    if (kind === "read") this.metrics.scheduleReads++;
    if (kind === "primaryWrite") this.metrics.primaryWrites++;
    if (kind === "fallbackWrite") this.metrics.fallbackWrites++;
  }

  recordAvoided(kind: "cache" | "backoff" | "coalesced" | "throttle"): void {
    if (kind === "cache") this.metrics.cacheAvoidedReads++;
    if (kind === "backoff") this.metrics.backoffAvoidedReads++;
    if (kind === "coalesced") this.metrics.coalescedChanges++;
    if (kind === "throttle") this.metrics.throttleAvoidedOperations++;
  }

  metricsSnapshot(): Readonly<typeof this.metrics> {
    return { ...this.metrics };
  }

  policyDescription(): string {
    return (
      `Schedule cloud policy: cache=${this.policy.cacheTtlMs / 60000}m; ` +
      `batchWindow=${this.policy.batchWindowMs}ms; writeSpacing=${this.policy.writeSpacingMs}ms; ` +
      `throttleCooldown=${this.policy.throttleCooldownMs / 60000}m.`
    );
  }
}

interface PendingScheduleWrite<T> {
  value: T;
  resolve: (executed: boolean) => void;
  reject: (error: unknown) => void;
}

export class ScheduleWriteBatcher<T> {
  private readonly queue = new ScheduleWriteQueue();
  private readonly pending = new Map<string, PendingScheduleWrite<T>>();
  private timer: ReturnType<typeof scheduleTimer> | undefined;

  constructor(
    private readonly executeBatch: (
      values: T[]
    ) => Promise<Map<string, unknown>>,
    private readonly keyOf: (value: T) => string,
    private readonly windowMs = SCHEDULE_WRITE_BATCH_WINDOW_MS,
    private readonly onSuperseded: () => void = () => undefined
  ) {}

  enqueue(value: T): Promise<boolean> {
    const key = this.keyOf(value);
    const superseded = this.pending.get(key);
    if (superseded) {
      this.onSuperseded();
      superseded.resolve(false);
    }

    const result = new Promise<boolean>((resolve, reject) => {
      this.pending.set(key, { value, resolve, reject });
    });

    if (!this.timer) {
      const timer = scheduleTimer(() => {
        this.timer = undefined;
        this.flush();
      }, this.windowMs);
      this.timer = timer;
      unrefTimer(timer);
    }

    return result;
  }

  cancelPending(): void {
    if (this.timer) {
      clearTimer(this.timer);
      this.timer = undefined;
    }

    for (const pending of this.pending.values()) {
      pending.resolve(false);
    }
    this.pending.clear();
    this.queue.cancelPending();
  }

  private flush(): void {
    const batch = [...this.pending.values()];
    this.pending.clear();

    void this.queue
      .enqueue(() => this.executeBatch(batch.map((pending) => pending.value)))
      .then(
        (failures) => {
          for (const pending of batch) {
            if (failures === undefined) {
              pending.resolve(false);
              continue;
            }
            const error = failures.get(this.keyOf(pending.value));
            if (error !== undefined) {
              pending.reject(error);
            } else {
              pending.resolve(true);
            }
          }
        },
        (error) => {
          for (const pending of batch) {
            pending.reject(error);
          }
        }
      );
  }
}

interface ScheduleWriteRequest {
  scheduleId: string;
  enabled: boolean;
}

export interface HapScheduleContext {
  kind: typeof HAP_EXTENSION_KIND;
  extension: typeof HAP_SCHEDULE_EXTENSION;
  duid: string;
}

export interface RoborockSchedule {
  id: string;
  enabled: boolean;
  timer: unknown[];
  /** Absent means `serverTimer`, so every older caller and cache keeps its meaning. */
  source?: ScheduleSource;
  /** The Routine's name in the app; only cloud scenes carry one. */
  name?: string;
}

export const HAP_ROUTINE_EXTENSION = "routines" as const;

export interface HapRoutineContext {
  kind: typeof HAP_EXTENSION_KIND;
  extension: typeof HAP_ROUTINE_EXTENSION;
  duid: string;
}

export function isHapRoutineAccessory(accessory: {
  context?: unknown;
}): boolean {
  const context = (accessory.context ?? {}) as Partial<HapRoutineContext>;
  return (
    context.kind === HAP_EXTENSION_KIND &&
    context.extension === HAP_ROUTINE_EXTENSION &&
    typeof context.duid === "string" &&
    context.duid.length > 0
  );
}

/** Timer-driven scenes become schedule switches; the id carries its source. */
export function scheduleFromCloudScene(
  scene: CloudScene
): RoborockSchedule | null {
  const position = cloudSceneSwitchPosition(scene);
  if (position === null) {
    return null;
  }

  return {
    id: `${CLOUD_SCENE_ID_PREFIX}${scene.id}`,
    enabled: position,
    timer: [scene.id, position ? "on" : "off"],
    source: "cloudScene",
    name: scene.name,
  };
}

export interface RoborockScheduleRefreshResult {
  success: boolean;
  hasSchedules: boolean;
}

/** One source's raw reading: asked and answered, asked and failed, or not asked. */
type SourceReading<T> =
  | { state: "read"; value: T }
  | { state: "failed"; error: unknown }
  | { state: "skipped" };

/** One source's reading turned into schedules, or the reason it could not be. */
interface SourceOutcome {
  ok: boolean;
  schedules: RoborockSchedule[];
  reason: string | undefined;
}

export function parseServerTimers(value: unknown): RoborockSchedule[] {
  if (!Array.isArray(value)) return [];

  const result = new Map<string, RoborockSchedule>();
  for (const timer of value) {
    if (!Array.isArray(timer) || timer.length < 2) continue;
    const [rawId, rawStatus] = timer;
    if (
      (typeof rawId !== "string" && typeof rawId !== "number") ||
      (rawStatus !== "on" && rawStatus !== "off")
    ) {
      continue;
    }

    const id = String(rawId);
    if (!id || result.has(id)) continue;
    result.set(id, {
      id,
      enabled: rawStatus === "on",
      timer: [...timer],
    });
  }

  return [...result.values()];
}

export function isHapScheduleAccessory(accessory: {
  context?: unknown;
}): boolean {
  const context = (accessory.context ?? {}) as Partial<HapScheduleContext>;
  return (
    context.kind === HAP_EXTENSION_KIND &&
    context.extension === HAP_SCHEDULE_EXTENSION &&
    typeof context.duid === "string" &&
    context.duid.length > 0
  );
}

/**
 * The platform owns one schedule coordinator per vacuum.
 * Each vacuum has one cached HAP PlatformAccessory, and each Roborock timer
 * is exposed as a Switch service within that shared accessory.
 *
 * Schedule services are intentionally named from the vacuum name so the
 * Home app presents the schedules together under the vacuum's schedule
 * grouping:
 *
 *   <vacuum> Schedule 1
 *   <vacuum> Schedule 2
 *   ...
 *
 * The manager UUID/context is derived from the vacuum duid. Each Switch
 * service subtype is derived from the schedule ID. Display names are not
 * identity and must never overwrite the shared manager accessory identity.
 */
export default class RoborockHapScheduleAccessory {
  private readonly scheduleAccessories = new Map<
    string,
    RoborockHapScheduleSwitchAccessory
  >();
  private readonly managerAccessory: PlatformAccessory;
  private vacuumName = "";
  private managerRemoved = false;
  private disposed = false;
  private cachedSchedules: RoborockSchedule[] | undefined;
  private lastScheduleRefreshAt = 0;
  private lastFailedRefreshAt = 0;
  private consecutiveRefreshFailures = 0;
  private nextRefreshAttemptAt = 0;
  private scheduleBackoffRandom = Math.random;
  private readonly writeBatcher: ScheduleWriteBatcher<ScheduleWriteRequest>;
  private refreshInProgress: Promise<RoborockScheduleRefreshResult> | undefined;
  private refreshInProgressStartedAt = 0;
  private refreshInProgressHoldsAccountQueue = false;
  private refreshGeneration = 0;
  // Once a robot has refused the device-side timer list it is not asked
  // again this session; see isServerTimerRefusal.
  private serverTimersRefused = false;
  private cloudScenesUnavailable = false;
  // The last good reading from each source, so a source that fails on one
  // refresh keeps its switches while the other source's reading is applied.
  private lastServerTimerSchedules: RoborockSchedule[] | undefined;
  private lastCloudSceneSchedules: RoborockSchedule[] | undefined;
  private lastCloudScenes: CloudScene[] | undefined;
  // The optional "<vacuum> Routines" accessory: one momentary switch per
  // Routine, timer or not. Owned here because it lives off the same scene
  // reading as the schedule switches.
  private routineAccessory: PlatformAccessory | undefined;
  private readonly routineSwitches = new Map<
    string,
    RoborockHapRoutineSwitch
  >();
  private exposeRoutines = false;
  private onRoutineCount: ((count: number) => void) | undefined;
  // Schedule switches are the default face of this coordinator; a user who
  // wants only the Routines still needs the scene reading, so the schedule
  // half can be switched off without losing the coordinator.
  private exposeSchedules = true;

  constructor(
    private readonly platform: RoborockPlatform,
    accessory: PlatformAccessory,
    private readonly duid: string,
    private readonly accountCoordinator = new ScheduleAccountCoordinator()
  ) {
    this.managerAccessory = accessory;
    this.writeBatcher = new ScheduleWriteBatcher<ScheduleWriteRequest>(
      (requests) => this.executeScheduleWriteBatch(requests),
      (request) => request.scheduleId,
      this.accountCoordinator.policy.batchWindowMs,
      () => this.accountCoordinator.recordAvoided("coalesced")
    );
    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid,
    } satisfies HapScheduleContext;
  }

  async initialize(vacuumName: string): Promise<RoborockScheduleRefreshResult> {
    this.vacuumName = vacuumName;
    this.disposed = false;

    const displayName = `${vacuumName} Schedules`;
    this.managerAccessory.displayName = displayName;

    this.managerAccessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid: this.duid,
    } satisfies HapScheduleContext;

    const info =
      this.managerAccessory.getService(
        this.platform.Service.AccessoryInformation
      ) ||
      this.managerAccessory.addService(
        this.platform.Service.AccessoryInformation
      );

    info.setCharacteristic(
      this.platform.Characteristic.Manufacturer,
      "Roborock"
    );
    info.setCharacteristic(this.platform.Characteristic.Model, "Schedules");
    info.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      `${this.duid}:schedules`
    );
    info.setCharacteristic(this.platform.Characteristic.Name, displayName);

    // The Routines accessory, when attached, is named after the same robot.
    this.applyRoutineAccessoryIdentity();

    // Initial discovery always performs one cloud schedule request.
    // Subsequent HomeKit reads use the cached snapshot until it expires.
    return this.refreshDetailed();
  }

  /**
   * Attach (or detach) the "<vacuum> Routines" accessory.
   *
   * The platform owns the PlatformAccessory — registration, cache, removal —
   * and hands it here so the switches inside it can follow the same scene
   * reading the schedule switches use. Passing `undefined` detaches: the
   * switches are disposed and the next sync creates none.
   */
  attachRoutineAccessory(
    accessory: PlatformAccessory | undefined,
    onRoutineCount?: (count: number) => void
  ): void {
    if (this.routineAccessory && this.routineAccessory !== accessory) {
      for (const child of this.routineSwitches.values()) {
        child.dispose();
      }
      this.routineSwitches.clear();
    }

    this.routineAccessory = accessory;
    this.exposeRoutines = accessory !== undefined;
    this.onRoutineCount = accessory ? onRoutineCount : undefined;

    if (!accessory) {
      return;
    }

    this.applyRoutineAccessoryIdentity();

    // Re-bind handlers to whatever switches Homebridge restored from its
    // cache, so a press works before the first scene reading has arrived.
    this.restoreRoutineHandlersFromAccessory();

    if (this.lastCloudScenes) {
      this.syncRoutines(this.lastCloudScenes);
    } else if (this.routineSwitches.size > 0) {
      // Restored from cache and not yet read: the accessory is already
      // registered (it came from the cache), so this only keeps the
      // platform's book in step.
      this.onRoutineCount?.(this.routineSwitches.size);
    }
  }

  /**
   * The Routines accessory's context and name. Applied when the accessory is
   * attached and again when the robot's name becomes known in initialize(),
   * because the platform attaches before it initialises; the accessory the
   * platform created already carries the right name, so the fallback here
   * only matters for a cached accessory being renamed.
   */
  private applyRoutineAccessoryIdentity(): void {
    const accessory = this.routineAccessory;
    if (!accessory) {
      return;
    }

    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_ROUTINE_EXTENSION,
      duid: this.duid,
    } satisfies HapRoutineContext;

    const displayName = this.vacuumName
      ? `${this.vacuumName} Routines`
      : accessory.displayName || "Roborock Routines";
    accessory.displayName = displayName;

    const info =
      accessory.getService(this.platform.Service.AccessoryInformation) ||
      accessory.addService(this.platform.Service.AccessoryInformation);
    info.setCharacteristic(
      this.platform.Characteristic.Manufacturer,
      "Roborock"
    );
    info.setCharacteristic(this.platform.Characteristic.Model, "Routines");
    info.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      `${this.duid}:routines`
    );
    info.setCharacteristic(this.platform.Characteristic.Name, displayName);
  }

  /**
   * Whether this coordinator creates and reads schedule switches at all.
   * Off means the device-side list is not read and no schedule switch is
   * kept; the scene reading continues for the Routines.
   */
  setScheduleExposure(on: boolean): void {
    this.exposeSchedules = on;
  }

  /** How many routine switches the last reading (or the cache) produced. */
  get routineCount(): number {
    return this.routineSwitches.size;
  }

  /**
   * Rebuild schedule child objects and attach their normal HAP handlers from
   * Switch services that Homebridge restored from its cached accessory state.
   *
   * This is local recovery state only. It is intentionally not written into
   * cachedSchedules or lastScheduleRefreshAt because the cloud snapshot is
   * still unknown. A later successful cloud refresh remains authoritative.
   */
  restoreScheduleHandlersFromAccessory(): boolean {
    const restored: RoborockSchedule[] = [];
    const seen = new Set<string>();
    let switchServiceCount = 0;
    let scheduleSwitchServiceCount = 0;

    for (const service of this.managerAccessory.services) {
      if (service.UUID !== this.platform.Service.Switch.UUID) {
        continue;
      }

      switchServiceCount++;

      const subtype = service.subtype;
      if (typeof subtype !== "string" || !subtype.startsWith(SERVICE_PREFIX)) {
        continue;
      }

      scheduleSwitchServiceCount++;

      let scheduleId: string;
      try {
        scheduleId = decodeURIComponent(subtype.slice(SERVICE_PREFIX.length));
      } catch {
        continue;
      }

      if (!scheduleId || seen.has(scheduleId)) {
        continue;
      }

      seen.add(scheduleId);

      const enabled = Boolean(
        service.getCharacteristic(this.platform.Characteristic.On).value
      );

      if (isCloudSceneScheduleId(scheduleId)) {
        // A cloud scene's switch remembers its Routine's name in the service
        // name; the scene itself is re-read before any write, so nothing
        // else needs restoring here.
        const rawName = service.getCharacteristic(
          this.platform.Characteristic.Name
        ).value;
        restored.push({
          id: scheduleId,
          enabled,
          timer: [
            cloudSceneIdFromScheduleId(scheduleId),
            enabled ? "on" : "off",
          ],
          source: "cloudScene",
          name:
            typeof rawName === "string" && rawName.trim()
              ? rawName
              : `Routine ${cloudSceneIdFromScheduleId(scheduleId)}`,
        });
        continue;
      }

      restored.push({
        id: scheduleId,
        enabled,
        timer: [scheduleId, enabled ? "on" : "off"],
      });
    }

    if (restored.length === 0) {
      this.platform.log.debug(
        `Schedule restoration for ${this.vacuumName}: ` +
          `managerUUID=${this.managerAccessory.UUID}; ` +
          `services=${this.managerAccessory.services.length}; ` +
          `switchServices=${switchServiceCount}; ` +
          `scheduleSwitchServices=${scheduleSwitchServiceCount}; ` +
          `restored=0; handlersReattached=false`
      );
      return false;
    }

    restored.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    );

    this.sync(restored);

    this.platform.log.debug(
      `Schedule restoration for ${this.vacuumName}: ` +
        `managerUUID=${this.managerAccessory.UUID}; ` +
        `services=${this.managerAccessory.services.length}; ` +
        `switchServices=${switchServiceCount}; ` +
        `scheduleSwitchServices=${scheduleSwitchServiceCount}; ` +
        `restored=${restored.length}; ` +
        `scheduleIds=${restored.map((schedule) => schedule.id).join(",")}; ` +
        `handlersReattached=true`
    );

    return true;
  }

  async refreshIfNeeded(): Promise<boolean> {
    const now = Date.now();

    this.platform.log.debug(
      `Schedule refreshIfNeeded: entered; ` +
        `cached=${this.cachedSchedules?.length ?? "undefined"}; ` +
        `lastRefreshAgeMs=${this.lastScheduleRefreshAt > 0 ? now - this.lastScheduleRefreshAt : "never"}; ` +
        `lastFailureAgeMs=${this.lastFailedRefreshAt > 0 ? now - this.lastFailedRefreshAt : "never"}; ` +
        `consecutiveFailures=${this.consecutiveRefreshFailures || 0}; ` +
        `nextAttemptInMs=${Math.max(0, (this.nextRefreshAttemptAt || 0) - now)}`
    );

    if (
      this.cachedSchedules !== undefined &&
      now - this.lastScheduleRefreshAt <
        this.accountCoordinator.policy.cacheTtlMs
    ) {
      this.platform.log.debug(
        `Schedule refreshIfNeeded: CACHE HIT; ` +
          `ageMs=${now - this.lastScheduleRefreshAt}; ` +
          `returning=${this.cachedSchedules.length > 0}`
      );
      this.accountCoordinator.recordAvoided("cache");
      return this.cachedSchedules.length > 0;
    }

    if (this.accountCoordinator.currentThrottleError(now) !== undefined) {
      this.platform.log.debug(
        `Schedule refreshIfNeeded: THROTTLE COOLDOWN; ` +
          `retryInMs=${this.accountCoordinator.cooldownRemainingMs(now)}; ` +
          `returning=${(this.cachedSchedules?.length ?? 0) > 0}`
      );
      this.accountCoordinator.recordAvoided("throttle");
      return (this.cachedSchedules?.length ?? 0) > 0;
    }

    if ((this.nextRefreshAttemptAt || 0) > now) {
      this.platform.log.debug(
        `Schedule refreshIfNeeded: FAILURE BACKOFF; ` +
          `ageMs=${now - this.lastFailedRefreshAt}; ` +
          `retryInMs=${this.nextRefreshAttemptAt - now}; ` +
          `returning=${(this.cachedSchedules?.length ?? 0) > 0}`
      );
      this.accountCoordinator.recordAvoided("backoff");
      return (this.cachedSchedules?.length ?? 0) > 0;
    }

    this.platform.log.debug(`Schedule refreshIfNeeded: CALLING refresh()`);

    return this.refresh();
  }

  async refresh(): Promise<boolean> {
    const result = await this.refreshDetailed();
    return result.hasSchedules;
  }

  async refreshAndGetSchedule(
    scheduleId: string,
    minimumRefreshStartedAt = 0
  ): Promise<RoborockSchedule | undefined> {
    await this.refreshDetailed(minimumRefreshStartedAt);

    const schedule = this.cachedSchedules?.find(
      (candidate) => candidate.id === scheduleId
    );

    return schedule
      ? {
          ...schedule,
          timer: [...schedule.timer],
        }
      : undefined;
  }

  private async refreshDetailed(
    minimumRefreshStartedAt = 0,
    accountCoordinatorHeld = false
  ): Promise<RoborockScheduleRefreshResult> {
    if (this.disposed) {
      return {
        success: false,
        hasSchedules: false,
      };
    }

    if (
      this.refreshInProgress &&
      this.refreshInProgressStartedAt >= minimumRefreshStartedAt &&
      // A caller that already holds the account queue must never adopt a
      // refresh that does not hold it. Such a refresh is waiting its turn
      // *behind* this caller, so waiting for it is a circular wait that no
      // request timeout can break: the queued read has not been issued, so
      // there is nothing to expire. It would strand the HomeKit write and
      // wedge the account queue for every vacuum until Homebridge restarts.
      (!accountCoordinatorHeld || this.refreshInProgressHoldsAccountQueue)
    ) {
      return this.refreshInProgress;
    }

    const startedAt = Date.now();
    const generation = ++this.refreshGeneration;

    const refresh = this.performRefresh(generation, accountCoordinatorHeld);

    this.refreshInProgress = refresh;
    this.refreshInProgressStartedAt = startedAt;
    this.refreshInProgressHoldsAccountQueue = accountCoordinatorHeld;

    try {
      return await refresh;
    } finally {
      // Only the current refresh is allowed to clear these fields. An older
      // refresh can finish after a newer verification refresh has started.
      if (this.refreshInProgress === refresh) {
        this.refreshInProgress = undefined;
        this.refreshInProgressStartedAt = 0;
        this.refreshInProgressHoldsAccountQueue = false;
      }
    }
  }

  /**
   * One reading of every source this robot has, applied together.
   *
   * Two sources feed the switch surface: the device-side timer list
   * (`get_server_timer`) and the account's timer-driven Routines
   * (`user/scene/device/{duid}`). A source that fails keeps its previous
   * switches while the other source's fresh reading is applied; only when
   * nothing could be read does the refresh count as failed and back off. A
   * robot that REFUSES the device-side list (`-10007 "Not FCC robot"`) is
   * not failing — it is telling us where not to look — so that answer is
   * remembered for the session and the source is dropped without a warning
   * on every refresh.
   */
  private async performRefresh(
    generation: number,
    accountCoordinatorHeld: boolean
  ): Promise<RoborockScheduleRefreshResult> {
    const preserved = () => ({
      success: false,
      hasSchedules: this.scheduleAccessories.size > 0,
    });

    try {
      const api = this.platform.roborockAPI as any;

      // A refresh can wait a long time in the account queue, and a newer
      // refresh may replace it while it waits. A superseded refresh is barred
      // from storing its result by the generation guards below, so issuing its
      // cloud requests once it reaches the front of the queue is pure waste.
      let superseded = false;
      const readAll = async (): Promise<
        | {
            timers: SourceReading<unknown>;
            scenes: SourceReading<CloudScene[]>;
          }
        | undefined
      > => {
        if (generation !== this.refreshGeneration || this.disposed) {
          superseded = true;
          return undefined;
        }

        const timers = await this.readServerTimers(api);
        const scenes = await this.readCloudScenes(api);
        return { timers, scenes };
      };

      const readings = accountCoordinatorHeld
        ? await readAll()
        : await this.accountCoordinator.enqueue(readAll, (error) => {
            throw error;
          });

      if (superseded || !readings) {
        return preserved();
      }

      // A newer refresh may have started while these requests were in flight.
      // The older request may finish, but it must never overwrite the newer
      // snapshot or its refresh timestamps.
      if (generation !== this.refreshGeneration || this.disposed) {
        return preserved();
      }

      const timerSchedules = this.serverTimerSchedulesFrom(readings.timers);
      const sceneSchedules = this.cloudSceneSchedulesFrom(readings.scenes);

      // A source that failed can only be papered over with its own previous
      // good reading. Without one — the first refresh after a restart, with
      // switches restored from the cache — applying the other source's list
      // would remove every switch the failed source owns, so the whole
      // refresh is preserved and backs off, exactly as it did with one source.
      const unrecoverable =
        (!timerSchedules.ok && this.lastServerTimerSchedules === undefined) ||
        (!sceneSchedules.ok && this.lastCloudSceneSchedules === undefined);

      if (unrecoverable) {
        // Keep every switch and back off.
        const throttled = [readings.timers, readings.scenes].find(
          (reading) =>
            reading.state === "failed" &&
            isDefiniteScheduleThrottle(reading.error)
        );
        if (throttled && throttled.state === "failed") {
          this.recordScheduleThrottle(throttled.error);
        } else {
          this.recordRefreshFailure();
        }

        const reasons = [timerSchedules, sceneSchedules]
          .filter((outcome) => !outcome.ok && outcome.reason)
          .map((outcome) => outcome.reason)
          .join("; ");
        this.platform.log.warn(
          `Unable to refresh Roborock schedules for ${this.duid}: ${reasons}. Preserving existing schedules.`
        );
        return preserved();
      }

      const merged: RoborockSchedule[] = [
        ...(timerSchedules.ok
          ? timerSchedules.schedules
          : this.lastServerTimerSchedules ?? []),
        ...(sceneSchedules.ok
          ? sceneSchedules.schedules
          : this.lastCloudSceneSchedules ?? []),
      ];

      if (timerSchedules.ok) {
        this.lastServerTimerSchedules = timerSchedules.schedules;
      } else if (timerSchedules.reason) {
        this.platform.log.warn(
          `Unable to refresh the device-side schedules for ${this.duid}: ${timerSchedules.reason}. Keeping the previous ones.`
        );
      }

      if (sceneSchedules.ok) {
        this.lastCloudSceneSchedules = sceneSchedules.schedules;
        if (readings.scenes.state === "read") {
          this.lastCloudScenes = readings.scenes.value;
        }
      } else if (sceneSchedules.reason) {
        this.platform.log.warn(
          `Unable to refresh the Routines for ${this.duid}: ${sceneSchedules.reason}. Keeping the previous ones.`
        );
      }

      this.cachedSchedules = merged.map((schedule) => ({
        ...schedule,
        timer: [...schedule.timer],
      }));
      this.lastScheduleRefreshAt = Date.now();
      this.clearRefreshFailure();

      this.platform.log.info(
        `Schedule parser: parsed ${this.duid}; result count=${merged.length}` +
          (readings.scenes.state === "read"
            ? ` (device timers=${timerSchedules.ok ? timerSchedules.schedules.length : "kept"}, ` +
              `cloud routines with a timer=${sceneSchedules.ok ? sceneSchedules.schedules.length : "kept"}` +
              `, routines in all=${readings.scenes.value.length})`
            : "") +
          "."
      );

      this.sync(merged);

      if (readings.scenes.state === "read") {
        this.syncRoutines(readings.scenes.value);
      }

      // A successful empty snapshot is authoritative information. It is
      // different from a failed/untrusted cloud response.
      return {
        success: true,
        hasSchedules: this.exposeSchedules !== false && merged.length > 0,
      };
    } catch (error) {
      if (generation !== this.refreshGeneration || this.disposed) {
        return preserved();
      }

      if (isDefiniteScheduleThrottle(error)) {
        this.recordScheduleThrottle(error);
      } else {
        this.recordRefreshFailure();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.warn(
        `Unable to refresh Roborock schedules for ${this.duid}: ${message}. Preserving existing schedules.`
      );
      return preserved();
    }
  }

  /** Read the device-side timer list, unless this robot has refused it before. */
  private async readServerTimers(api: any): Promise<SourceReading<unknown>> {
    if (this.serverTimersRefused || this.exposeSchedules === false) {
      return { state: "skipped" };
    }

    try {
      this.accountCoordinator.recordRequest("read");
      const value = await getServerTimers(api, this.duid, {
        requestTimeoutMs: 10000,
      });
      return { state: "read", value };
    } catch (error) {
      if (isServerTimerRefusal(error)) {
        this.serverTimersRefused = true;
        this.platform.log.info(
          `${this.vacuumName || this.duid} does not offer a device-side schedule list (${
            error instanceof Error ? error.message : String(error)
          }). Its schedules are read from the account's Routines instead, and the device-side list is not asked again this session.`
        );
        return { state: "skipped" };
      }
      return { state: "failed", error };
    }
  }

  /**
   * Read the account's Routines for this robot.
   *
   * A 4xx from the cloud is the account saying this robot has no Routines it
   * will show us — a robot shared from another account, for instance — and it
   * will say so on every refresh, so like a device-side refusal it is
   * remembered for the session and the source is skipped from then on.
   * Anything else (network, 5xx, throttle) is a failure to retry.
   */
  private async readCloudScenes(
    api: any
  ): Promise<SourceReading<CloudScene[]>> {
    if (
      this.cloudScenesUnavailable ||
      typeof api?.getCloudScenes !== "function"
    ) {
      // No scene API at all is not a failure of the cloud; it is a client
      // that cannot ask, and asking again would not change that.
      return { state: "skipped" };
    }

    try {
      this.accountCoordinator.recordRequest("read");
      const value = await getCloudScenes(api, this.duid);
      return { state: "read", value };
    } catch (error) {
      const status = Number(
        (error as { response?: { status?: unknown } })?.response?.status ??
          (error as { status?: unknown })?.status
      );
      if (status >= 400 && status < 500 && status !== 429) {
        this.cloudScenesUnavailable = true;
        this.platform.log.info(
          `The Roborock account does not show Routines for ${this.vacuumName || this.duid} (HTTP ${status}); they are not asked for again this session.`
        );
        return { state: "skipped" };
      }
      return { state: "failed", error };
    }
  }

  /**
   * Turn a device-side reading into schedules, with the two trust checks the
   * source has always had: a non-array answer and a non-empty answer that
   * parses to nothing are both untrusted, and neither may delete switches.
   */
  private serverTimerSchedulesFrom(
    reading: SourceReading<unknown>
  ): SourceOutcome {
    if (reading.state === "skipped") {
      return { ok: true, schedules: [], reason: undefined };
    }
    if (reading.state === "failed") {
      return {
        ok: false,
        schedules: [],
        reason:
          reading.error instanceof Error
            ? reading.error.message
            : String(reading.error),
      };
    }

    const raw = reading.value;
    this.platform.log.debug(
      `Schedule discovery for ${this.duid}: ` +
        `type=${Array.isArray(raw) ? "array" : typeof raw}, ` +
        `value=${JSON.stringify(raw)}`
    );

    if (!Array.isArray(raw)) {
      return {
        ok: false,
        schedules: [],
        reason: `get_server_timer returned ${typeof raw}`,
      };
    }

    const schedules = parseServerTimers(raw);
    if (raw.length > 0 && schedules.length === 0) {
      return {
        ok: false,
        schedules: [],
        reason:
          "get_server_timer returned a non-empty response that parsed to zero schedules",
      };
    }

    // Keep display numbering stable even if Roborock returns schedules
    // in a different order between refreshes.
    schedules.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    );

    return { ok: true, schedules, reason: undefined };
  }

  /** Timer-driven Routines become schedule switches, in the app's own order. */
  private cloudSceneSchedulesFrom(
    reading: SourceReading<CloudScene[]>
  ): SourceOutcome {
    if (reading.state === "skipped") {
      return { ok: true, schedules: [], reason: undefined };
    }
    if (reading.state === "failed") {
      return {
        ok: false,
        schedules: [],
        reason:
          reading.error instanceof Error
            ? reading.error.message
            : String(reading.error),
      };
    }

    const schedules: RoborockSchedule[] = [];
    for (const scene of reading.value) {
      const schedule = scheduleFromCloudScene(scene);
      if (schedule) {
        schedules.push(schedule);
      }
    }

    return { ok: true, schedules, reason: undefined };
  }

  recordScheduleUpdate(schedule: RoborockSchedule): void {
    const updated = {
      ...schedule,
      timer: [...schedule.timer],
    };

    const schedules = this.cachedSchedules
      ? this.cachedSchedules.map((candidate) =>
          candidate.id === updated.id
            ? { ...updated }
            : { ...candidate, timer: [...candidate.timer] }
        )
      : [updated];

    if (!schedules.some((candidate) => candidate.id === updated.id)) {
      schedules.push(updated);
    }

    this.cachedSchedules = schedules;
    this.lastScheduleRefreshAt = Date.now();
  }

  enqueueScheduleWrite(scheduleId: string, enabled: boolean): Promise<boolean> {
    return this.writeBatcher.enqueue({ scheduleId, enabled });
  }

  private async executeScheduleWriteBatch(
    requests: ScheduleWriteRequest[]
  ): Promise<Map<string, unknown>> {
    const result = await this.accountCoordinator.enqueue(
      () => this.executeAccountCoordinatedScheduleWriteBatch(requests),
      (error) => new Map(requests.map((request) => [request.scheduleId, error]))
    );
    this.logScheduleMetrics();
    return result;
  }

  private async executeAccountCoordinatedScheduleWriteBatch(
    requests: ScheduleWriteRequest[]
  ): Promise<Map<string, unknown>> {
    const failures = new Map<string, unknown>();
    const primarySent: ScheduleWriteRequest[] = [];
    const api = this.platform.roborockAPI as any;
    const primaryStartedAt = Date.now();

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      if (index > 0) {
        await this.waitForScheduleWriteSpacing();
      }

      try {
        this.platform.log.info(
          `Schedule command: ${request.enabled ? "enabling" : "disabling"} ${this.duid}/${request.scheduleId}.`
        );
        this.accountCoordinator.recordRequest("primaryWrite");
        if (isCloudSceneScheduleId(request.scheduleId)) {
          await this.writeCloudSceneSchedule(api, request);
        } else {
          await updateServerTimer(
            api,
            this.duid,
            request.scheduleId,
            request.enabled,
            { requestTimeoutMs: 10000 }
          );
        }
        primarySent.push(request);
      } catch (error) {
        failures.set(request.scheduleId, error);
        if (isDefiniteScheduleThrottle(error)) {
          this.recordScheduleThrottle(error);
          return new Map(
            requests.map((candidate) => [candidate.scheduleId, error])
          );
        }
      }
    }

    if (primarySent.length === 0 || this.disposed) {
      return failures;
    }

    await this.waitForScheduleVerification();
    await this.refreshDetailed(primaryStartedAt, true);

    const throttleError = this.accountCoordinator.currentThrottleError();
    if (throttleError !== undefined) {
      return new Map(
        requests.map((request) => [request.scheduleId, throttleError])
      );
    }

    const unconfirmed = primarySent.filter(
      (request) => !this.cachedScheduleMatches(request)
    );
    // The upd_timer fallback is a device-side command; a cloud scene has no
    // second route to try, so an unconfirmed scene write is simply a failure
    // the switch reverts from.
    const fallback = unconfirmed.filter(
      (request) => !isCloudSceneScheduleId(request.scheduleId)
    );
    const primaryConfirmed = primarySent.length - unconfirmed.length;
    this.platform.log.info(
      `Schedule batch verification for ${this.duid}: ` +
        `requested=${requests.length}; primarySent=${primarySent.length}; ` +
        `primaryConfirmed=${primaryConfirmed}; fallbackNeeded=${fallback.length}.`
    );
    for (const request of primarySent) {
      if (!unconfirmed.includes(request)) {
        failures.delete(request.scheduleId);
      } else if (isCloudSceneScheduleId(request.scheduleId)) {
        failures.set(
          request.scheduleId,
          new Error(
            `Roborock did not confirm routine ${cloudSceneIdFromScheduleId(request.scheduleId)} as ${request.enabled ? "enabled" : "disabled"} when it was read back`
          )
        );
      }
    }

    if (fallback.length === 0 || this.disposed) {
      return failures;
    }

    const fallbackSent: ScheduleWriteRequest[] = [];
    const fallbackStartedAt = Date.now();
    for (let index = 0; index < fallback.length; index++) {
      const request = fallback[index];
      if (index > 0) {
        await this.waitForScheduleWriteSpacing();
      }

      try {
        this.platform.log.warn(
          `Schedule command: upd_server_timer was not confirmed for ${this.duid}/${request.scheduleId}; trying upd_timer fallback.`
        );
        this.accountCoordinator.recordRequest("fallbackWrite");
        await updateTimer(api, this.duid, request.scheduleId, request.enabled, {
          requestTimeoutMs: 10000,
        });
        fallbackSent.push(request);
      } catch (error) {
        failures.set(request.scheduleId, error);
        if (isDefiniteScheduleThrottle(error)) {
          this.recordScheduleThrottle(error);
          for (const candidate of fallback) {
            failures.set(candidate.scheduleId, error);
          }
          return failures;
        }
      }
    }

    if (fallbackSent.length > 0 && !this.disposed) {
      await this.waitForScheduleVerification();
      await this.refreshDetailed(fallbackStartedAt, true);
    }

    for (const request of fallbackSent) {
      if (this.cachedScheduleMatches(request)) {
        failures.delete(request.scheduleId);
      } else {
        failures.set(
          request.scheduleId,
          new Error(
            `Roborock did not confirm schedule ${request.scheduleId} as ${request.enabled ? "enabled" : "disabled"}`
          )
        );
      }
    }

    const fallbackConfirmed = fallbackSent.filter((request) =>
      this.cachedScheduleMatches(request)
    ).length;
    this.platform.log.info(
      `Schedule fallback verification for ${this.duid}: ` +
        `requested=${requests.length}; primarySent=${primarySent.length}; ` +
        `primaryConfirmed=${primaryConfirmed}; fallbackNeeded=${fallback.length}; ` +
        `fallbackSent=${fallbackSent.length}; fallbackConfirmed=${fallbackConfirmed}; ` +
        `failed=${failures.size}.`
    );

    return failures;
  }

  /**
   * Switch one cloud scene's schedule, against a FRESH reading of the scene.
   *
   * The write replaces the scene's whole `param`, so it must be built from
   * what the cloud holds now and not from a snapshot up to five minutes old:
   * a room list edited in the app in between would otherwise be reverted by
   * a HomeKit switch that meant to change one flag. One extra read per write
   * is the price of never doing that.
   */
  private async writeCloudSceneSchedule(
    api: any,
    request: ScheduleWriteRequest
  ): Promise<void> {
    const sceneId = cloudSceneIdFromScheduleId(request.scheduleId);
    this.accountCoordinator.recordRequest("read");
    const scenes = await getCloudScenes(api, this.duid);
    this.lastCloudScenes = scenes;

    const scene = scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      throw new Error(
        `routine ${sceneId} no longer exists on the Roborock account; its switch will disappear on the next refresh`
      );
    }

    await setCloudSceneScheduleEnabled(api, scene, request.enabled);
  }

  /**
   * Run one Routine now. Called by a routine switch; never throws, because a
   * HAP set handler that throws shows as a broken accessory rather than as
   * the reason.
   */
  async runRoutine(sceneId: string, displayName: string): Promise<void> {
    const api = this.platform.roborockAPI as any;
    try {
      this.platform.log.info(`Running Roborock routine "${displayName}".`);
      await this.accountCoordinator.enqueue(
        async () => {
          this.accountCoordinator.recordRequest("primaryWrite");
          await executeCloudScene(api, sceneId);
        },
        (error) => {
          throw error;
        }
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to run Roborock routine "${displayName}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Bring the routine switches in line with the scenes just read: one
   * momentary switch per Routine, named as in the app, stale ones removed.
   */
  private syncRoutines(scenes: CloudScene[]): void {
    const accessory = this.routineAccessory;
    if (!accessory || !this.exposeRoutines) {
      return;
    }

    const ids = new Set(scenes.map((scene) => scene.id));
    let changed = false;

    for (const scene of scenes) {
      const existing = this.routineSwitches.get(scene.id);
      if (existing) {
        existing.updateIdentity(scene.name);
        continue;
      }

      const child = new RoborockHapRoutineSwitch(
        this.platform,
        this,
        accessory,
        scene.id
      );
      child.initialize(scene.name);
      this.routineSwitches.set(scene.id, child);
      changed = true;
      this.platform.log.debug(
        `Routine sync: added HAP switch '${scene.name}' for scene ${scene.id}.`
      );
    }

    for (const [id, child] of this.routineSwitches) {
      if (ids.has(id)) continue;

      this.platform.log.debug(
        `Routine sync: removing stale HAP switch for ${id}.`
      );
      child.dispose();
      const service = accessory.getServiceById(
        this.platform.Service.Switch,
        `${ROUTINE_SERVICE_PREFIX}${encodeURIComponent(id)}`
      );
      if (service) {
        accessory.removeService(service);
      }
      this.routineSwitches.delete(id);
      changed = true;
    }

    if (changed) {
      this.platform.api.updatePlatformAccessories([accessory]);
    }

    this.onRoutineCount?.(this.routineSwitches.size);
  }

  /**
   * Re-bind handlers to routine switches Homebridge restored from its cache,
   * so a press works before the first scene reading has arrived. Like the
   * schedule restoration, this is local recovery: the next reading is
   * authoritative and may remove a routine that no longer exists.
   */
  private restoreRoutineHandlersFromAccessory(): void {
    const accessory = this.routineAccessory;
    if (!accessory) {
      return;
    }

    for (const service of accessory.services) {
      if (service.UUID !== this.platform.Service.Switch.UUID) continue;
      const subtype = service.subtype;
      if (
        typeof subtype !== "string" ||
        !subtype.startsWith(ROUTINE_SERVICE_PREFIX)
      ) {
        continue;
      }

      let sceneId: string;
      try {
        sceneId = decodeURIComponent(
          subtype.slice(ROUTINE_SERVICE_PREFIX.length)
        );
      } catch {
        continue;
      }
      if (!sceneId || this.routineSwitches.has(sceneId)) continue;

      const rawName = service.getCharacteristic(
        this.platform.Characteristic.Name
      ).value;
      const name =
        typeof rawName === "string" && rawName.trim()
          ? rawName
          : `Routine ${sceneId}`;

      const child = new RoborockHapRoutineSwitch(
        this.platform,
        this,
        accessory,
        sceneId
      );
      child.initialize(name);
      this.routineSwitches.set(sceneId, child);
    }
  }

  private cachedScheduleMatches(request: ScheduleWriteRequest): boolean {
    return (
      this.cachedSchedules?.some(
        (schedule) =>
          schedule.id === request.scheduleId &&
          schedule.enabled === request.enabled
      ) === true
    );
  }

  private async waitForScheduleVerification(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = scheduleTimer(resolve, VERIFY_DELAY_MS);
      unrefTimer(timer);
    });
  }

  private async waitForScheduleWriteSpacing(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = scheduleTimer(
        resolve,
        this.accountCoordinator.policy.writeSpacingMs
      );
      unrefTimer(timer);
    });
  }

  private recordRefreshFailure(): void {
    const now = Date.now();
    this.lastFailedRefreshAt = now;
    this.consecutiveRefreshFailures =
      (this.consecutiveRefreshFailures || 0) + 1;
    const delay = scheduleFailureBackoffMs(
      this.consecutiveRefreshFailures,
      (this.scheduleBackoffRandom || Math.random)()
    );
    this.nextRefreshAttemptAt = now + delay;
  }

  private clearRefreshFailure(): void {
    this.lastFailedRefreshAt = 0;
    this.consecutiveRefreshFailures = 0;
    this.nextRefreshAttemptAt = 0;
  }

  private recordScheduleThrottle(error: unknown): void {
    this.accountCoordinator.recordThrottle(error);
    this.platform.log.warn(
      `Roborock schedule requests for this account appear rate-limited; pausing this vacuum's schedule traffic for ${this.accountCoordinator.policy.throttleCooldownMs / 60000} minutes.`
    );
  }

  private logScheduleMetrics(): void {
    const metrics = this.accountCoordinator.metricsSnapshot();
    this.platform.log.debug(
      `Schedule cloud totals: reads=${metrics.scheduleReads}; ` +
        `primaryWrites=${metrics.primaryWrites}; fallbackWrites=${metrics.fallbackWrites}; ` +
        `coalesced=${metrics.coalescedChanges}; cacheAvoidedReads=${metrics.cacheAvoidedReads}; ` +
        `backoffAvoidedReads=${metrics.backoffAvoidedReads}; ` +
        `throttleAvoidedOperations=${metrics.throttleAvoidedOperations}.`
    );
  }

  /**
   * Stop in-memory work without changing the cached HAP service topology.
   * Normal Homebridge shutdown must preserve the same service instances so
   * Home custom names, room placement, scenes, and automations survive.
   */
  shutdown(): void {
    this.stopRuntime();
  }

  /**
   * Intentionally remove every schedule service while preserving the manager.
   * This is used only when schedule exposure is disabled or the manager is
   * about to be unregistered. Individual schedules deleted from Roborock are
   * removed separately by a successful authoritative sync.
   */
  removeScheduleServices(): void {
    if (this.exposeRoutines && this.routineAccessory) {
      // The Routines still need this coordinator's readings; only the
      // schedule half goes.
      this.removeScheduleSwitchesOnly();
      return;
    }

    this.stopRuntime();

    for (const service of [...this.managerAccessory.services]) {
      if (service.UUID === this.platform.Service.Switch.UUID) {
        this.managerAccessory.removeService(service);
      }
    }

    this.platform.api.updatePlatformAccessories([this.managerAccessory]);
  }

  /** Drop every schedule switch and its pending writes, keeping the coordinator alive. */
  private removeScheduleSwitchesOnly(): void {
    this.writeBatcher.cancelPending();
    for (const schedule of this.scheduleAccessories.values()) {
      schedule.dispose();
    }
    this.scheduleAccessories.clear();
    this.lastServerTimerSchedules = undefined;
    this.lastCloudSceneSchedules = undefined;

    for (const service of [...this.managerAccessory.services]) {
      if (service.UUID === this.platform.Service.Switch.UUID) {
        this.managerAccessory.removeService(service);
      }
    }

    this.platform.api.updatePlatformAccessories([this.managerAccessory]);
  }

  private stopRuntime(): void {
    this.disposed = true;
    this.refreshGeneration++;
    this.refreshInProgress = undefined;
    this.refreshInProgressStartedAt = 0;
    this.refreshInProgressHoldsAccountQueue = false;
    this.cachedSchedules = undefined;
    this.lastScheduleRefreshAt = 0;
    this.clearRefreshFailure();
    this.writeBatcher.cancelPending();

    for (const schedule of this.scheduleAccessories.values()) {
      schedule.dispose();
    }

    this.scheduleAccessories.clear();

    for (const routine of this.routineSwitches.values()) {
      routine.dispose();
    }
    this.routineSwitches.clear();
    this.lastServerTimerSchedules = undefined;
    this.lastCloudSceneSchedules = undefined;
    this.lastCloudScenes = undefined;
  }

  /**
   * Remove every routine switch while preserving the accessory, when routine
   * exposure is switched off or the accessory is about to be unregistered.
   */
  removeRoutineServices(): void {
    const accessory = this.routineAccessory;
    for (const routine of this.routineSwitches.values()) {
      routine.dispose();
    }
    this.routineSwitches.clear();
    this.exposeRoutines = false;
    this.onRoutineCount = undefined;

    if (!accessory) {
      return;
    }

    for (const service of [...accessory.services]) {
      if (service.UUID === this.platform.Service.Switch.UUID) {
        accessory.removeService(service);
      }
    }
    this.platform.api.updatePlatformAccessories([accessory]);
    this.routineAccessory = undefined;
  }

  private sync(schedules: RoborockSchedule[]): void {
    if (this.exposeSchedules === false) {
      // Routines only: the reading is still applied to the routine
      // switches by the caller, but no schedule switch may exist.
      if (this.scheduleAccessories.size > 0) {
        this.removeScheduleSwitchesOnly();
      }
      return;
    }

    this.platform.log.debug(
      `Schedule sync: ${this.duid} received ${schedules.length} parsed schedule(s).`
    );

    const ids = new Set(schedules.map((schedule) => schedule.id));

    // Device-side timers carry no name, so they are numbered as they always
    // were; a Routine's schedule is named after the Routine, exactly as the
    // app shows it. Numbering counts only the timers, so adding a Routine
    // never renames "Schedule 2" to "Schedule 3".
    let timerOrdinal = 0;
    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      const displayName =
        schedule.source === "cloudScene"
          ? schedule.name ||
            `${this.vacuumName} Routine ${cloudSceneIdFromScheduleId(schedule.id)}`
          : `${this.vacuumName} Schedule ${++timerOrdinal}`;
      const existing = this.scheduleAccessories.get(schedule.id);

      if (existing) {
        existing.updateIdentity(displayName, schedule);
        continue;
      }

      const child = new RoborockHapScheduleSwitchAccessory(
        this.platform,
        this,
        this.managerAccessory,
        this.duid,
        schedule.id
      );

      child.initialize(displayName, schedule);
      this.scheduleAccessories.set(schedule.id, child);

      this.platform.log.debug(
        `Schedule sync: added HAP switch '${displayName}' for ${schedule.id}.`
      );
    }

    for (const [id, child] of this.scheduleAccessories) {
      if (ids.has(id)) continue;

      this.platform.log.debug(
        `Schedule sync: removing stale HAP switch for ${id}.`
      );
      child.dispose();

      const service = this.managerAccessory.getServiceById(
        this.platform.Service.Switch,
        `${SERVICE_PREFIX}${encodeURIComponent(id)}`
      );

      if (service) {
        this.managerAccessory.removeService(service);
      }

      this.scheduleAccessories.delete(id);
      this.platform.api.updatePlatformAccessories([this.managerAccessory]);
    }
  }

  private removeFromPlatformCache(accessory: PlatformAccessory): void {
    const cachedAccessories = ((this.platform as any).accessories ??
      []) as PlatformAccessory[];
    const index = cachedAccessories.indexOf(accessory);
    if (index >= 0) {
      cachedAccessories.splice(index, 1);
    }
  }
}

class RoborockHapScheduleSwitchAccessory {
  private readonly suppression = new Map<
    string,
    { enabled: boolean; timestamp: number }
  >();

  // If Roborock rejects/doesn't reflect a command, don't allow HomeKit
  // to immediately hammer the same command over and over.
  private readonly failedCommands = new Map<
    string,
    { enabled: boolean; timestamp: number }
  >();

  private static readonly FAILED_COMMAND_COOLDOWN_MS = 30000;

  private schedule: RoborockSchedule;
  private disposed = false;

  constructor(
    private readonly platform: RoborockPlatform,
    private readonly coordinator: RoborockHapScheduleAccessory,
    public readonly accessory: PlatformAccessory,
    private readonly duid: string,
    private readonly scheduleId: string
  ) {
    this.schedule = {
      id: scheduleId,
      enabled: false,
      timer: [scheduleId, "off"],
    };
  }

  initialize(displayName: string, schedule: RoborockSchedule): void {
    this.disposed = false;
    this.updateIdentity(displayName, schedule);

    const subtype = `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`;
    let service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      subtype
    );

    if (!service) {
      service = this.accessory.addService(
        this.platform.Service.Switch,
        displayName,
        subtype
      );
    }

    service.displayName = displayName;
    service.setCharacteristic(this.platform.Characteristic.Name, displayName);
    service.addOptionalCharacteristic(
      this.platform.Characteristic.ConfiguredName
    );

    const configuredName = service.getCharacteristic(
      this.platform.Characteristic.ConfiguredName
    );
    const currentConfiguredName = configuredName.value;

    if (
      currentConfiguredName == null ||
      String(currentConfiguredName).trim().length === 0 ||
      String(currentConfiguredName) === displayName
    ) {
      configuredName.setValue(displayName);
    }

    service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet((value) => this.setSchedule(Boolean(value)))
      .onGet(() => {
        void this.coordinator.refreshIfNeeded();
        return this.schedule.enabled;
      });
    service.updateCharacteristic(
      this.platform.Characteristic.On,
      schedule.enabled
    );
  }

  updateIdentity(displayName: string, schedule: RoborockSchedule): void {
    this.schedule = { ...schedule, timer: [...schedule.timer] };

    const switchService = this.accessory.getServiceById(
      this.platform.Service.Switch,
      `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`
    );
    if (switchService) {
      const previousServiceName = switchService.getCharacteristic(
        this.platform.Characteristic.Name
      ).value;

      switchService.displayName = displayName;

      switchService.setCharacteristic(
        this.platform.Characteristic.Name,
        displayName
      );
      switchService.addOptionalCharacteristic(
        this.platform.Characteristic.ConfiguredName
      );
      const configuredName = switchService.getCharacteristic(
        this.platform.Characteristic.ConfiguredName
      );
      const currentConfiguredName = configuredName.value;
      if (
        currentConfiguredName == null ||
        String(currentConfiguredName).trim().length === 0 ||
        String(currentConfiguredName) === String(previousServiceName)
      ) {
        configuredName.setValue(displayName);
      }
      switchService.updateCharacteristic(
        this.platform.Characteristic.On,
        schedule.enabled
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    this.suppression.clear();
    this.failedCommands.clear();
  }

  private async setSchedule(enabled: boolean): Promise<void> {
    const previous = this.schedule.enabled;
    const now = Date.now();
    const last = this.suppression.get(this.scheduleId);

    if (
      last &&
      last.enabled === enabled &&
      now - last.timestamp < WRITE_SUPPRESSION_MS
    ) {
      return;
    }

    const failed = this.failedCommands.get(this.scheduleId);
    if (
      failed &&
      failed.enabled === enabled &&
      now - failed.timestamp <
        RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS
    ) {
      this.updateService(previous);
      return;
    }

    try {
      this.platform.log.info(
        `Schedule command: queueing ${enabled ? "enable" : "disable"} for ${this.duid}/${this.scheduleId}.`
      );
      const executed = await this.coordinator.enqueueScheduleWrite(
        this.scheduleId,
        enabled
      );

      if (!executed) {
        return;
      }

      if (this.disposed) {
        return;
      }

      this.schedule.enabled = enabled;
      this.schedule.timer[1] = enabled ? "on" : "off";
      this.failedCommands.delete(this.scheduleId);
      this.suppression.set(this.scheduleId, {
        enabled,
        timestamp: Date.now(),
      });
      this.updateService(enabled);
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.updateService(previous);

      this.failedCommands.set(this.scheduleId, {
        enabled,
        timestamp: Date.now(),
      });

      const message = error instanceof Error ? error.message : String(error);

      this.platform.log.warn(
        `Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${this.scheduleId}: ${message}. ` +
          `Further attempts for this same state are suppressed for ` +
          `${RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS / 1000}s.`
      );
    }
  }

  private updateService(enabled: boolean): void {
    const service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`
    );
    service?.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}

/**
 * One Routine, as a momentary switch: on runs it, and 1.5 s later the switch
 * falls back to off by itself. Siri can therefore start "Saugen+" by name,
 * and a Home automation can run a Routine the way it runs a scene.
 */
class RoborockHapRoutineSwitch {
  private resetTimer: ReturnType<typeof scheduleTimer> | undefined;
  private disposed = false;
  private displayName = "";

  constructor(
    private readonly platform: RoborockPlatform,
    private readonly coordinator: RoborockHapScheduleAccessory,
    public readonly accessory: PlatformAccessory,
    private readonly sceneId: string
  ) {}

  private get subtype(): string {
    return `${ROUTINE_SERVICE_PREFIX}${encodeURIComponent(this.sceneId)}`;
  }

  initialize(displayName: string): void {
    this.disposed = false;
    this.displayName = displayName;

    let service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      this.subtype
    );
    if (!service) {
      service = this.accessory.addService(
        this.platform.Service.Switch,
        displayName,
        this.subtype
      );
    }

    this.applyName(service, displayName);

    const on = service.getCharacteristic(this.platform.Characteristic.On);
    // Cached services are configured again on every launch, and a second set
    // of handlers on the same characteristic would run the Routine twice.
    on.removeAllListeners("get");
    on.removeAllListeners("set");
    on.onGet(() => {
      // A momentary switch reads off; the read is still a good moment to
      // let the coordinator refresh its scene list (5-minute cache), so a
      // Routine added in the app reaches Apple Home without a restart even
      // when there is no schedule switch to prompt a refresh.
      void this.coordinator.refreshIfNeeded();
      return false;
    }).onSet((value) => this.handlePress(Boolean(value)));

    // Whatever the cache remembered, a momentary switch starts off.
    service.updateCharacteristic(this.platform.Characteristic.On, false);
  }

  /** Follow a rename in the Roborock app through to Apple Home. */
  updateIdentity(displayName: string): void {
    if (displayName === this.displayName) {
      return;
    }
    this.displayName = displayName;
    const service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      this.subtype
    );
    if (service) {
      this.applyName(service, displayName);
    }
  }

  private applyName(
    service: ReturnType<PlatformAccessory["addService"]>,
    displayName: string
  ): void {
    const previous = service.getCharacteristic(
      this.platform.Characteristic.Name
    ).value;
    service.displayName = displayName;
    service.setCharacteristic(this.platform.Characteristic.Name, displayName);
    service.addOptionalCharacteristic(
      this.platform.Characteristic.ConfiguredName
    );
    const configuredName = service.getCharacteristic(
      this.platform.Characteristic.ConfiguredName
    );
    const current = configuredName.value;
    // A name the user chose in the Home app is theirs; only a name that still
    // mirrors the previous app name follows the app.
    if (
      current == null ||
      String(current).trim().length === 0 ||
      String(current) === String(previous)
    ) {
      configuredName.setValue(displayName);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.resetTimer) {
      clearTimer(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  private async handlePress(value: boolean): Promise<void> {
    if (!value || this.disposed) {
      // The switch turning itself off again. Not a command.
      return;
    }

    this.scheduleReset();
    await this.coordinator.runRoutine(this.sceneId, this.displayName);
  }

  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimer(this.resetTimer);
    }
    const timer = scheduleTimer(() => {
      this.resetTimer = undefined;
      if (this.disposed) return;
      this.accessory
        .getServiceById(this.platform.Service.Switch, this.subtype)
        ?.updateCharacteristic(this.platform.Characteristic.On, false);
    }, ROUTINE_SWITCH_AUTO_RESET_MS);
    unrefTimer(timer);
    this.resetTimer = timer;
  }
}
