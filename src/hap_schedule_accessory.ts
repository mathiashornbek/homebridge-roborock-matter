import { PlatformAccessory } from "homebridge";
import RoborockPlatform from "./platform";
import {
  getServerTimers,
  updateServerTimer,
  updateTimer,
} from "./hap_schedule_api";
import { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME } from "./settings";
import { clearTimer, scheduleTimer, unrefTimer } from "./timers";

const VERIFY_DELAY_MS = 3000;
const WRITE_SUPPRESSION_MS = 5000;
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
}

export interface RoborockScheduleRefreshResult {
  success: boolean;
  hasSchedules: boolean;
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
  private refreshGeneration = 0;

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

    // Initial discovery always performs one cloud schedule request.
    // Subsequent HomeKit reads use the cached snapshot until it expires.
    return this.refreshDetailed();
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
      this.refreshInProgressStartedAt >= minimumRefreshStartedAt
    ) {
      return this.refreshInProgress;
    }

    const startedAt = Date.now();
    const generation = ++this.refreshGeneration;

    const refresh = this.performRefresh(generation, accountCoordinatorHeld);

    this.refreshInProgress = refresh;
    this.refreshInProgressStartedAt = startedAt;

    try {
      return await refresh;
    } finally {
      // Only the current refresh is allowed to clear these fields. An older
      // refresh can finish after a newer verification refresh has started.
      if (this.refreshInProgress === refresh) {
        this.refreshInProgress = undefined;
        this.refreshInProgressStartedAt = 0;
      }
    }
  }

  private async performRefresh(
    generation: number,
    accountCoordinatorHeld: boolean
  ): Promise<RoborockScheduleRefreshResult> {
    try {
      const api = this.platform.roborockAPI as any;
      const readSchedules = () => {
        this.accountCoordinator.recordRequest("read");
        return getServerTimers(api, this.duid, {
          requestTimeoutMs: 10000,
        });
      };
      const raw = accountCoordinatorHeld
        ? await readSchedules()
        : await this.accountCoordinator.enqueue(readSchedules, (error) => {
            throw error;
          });

      this.platform.log.debug(
        `Schedule discovery for ${this.duid}: ` +
          `type=${Array.isArray(raw) ? "array" : typeof raw}, ` +
          `value=${JSON.stringify(raw)}`
      );

      if (!Array.isArray(raw)) {
        if (generation !== this.refreshGeneration || this.disposed) {
          return {
            success: false,
            hasSchedules: this.scheduleAccessories.size > 0,
          };
        }

        this.recordRefreshFailure();
        this.platform.log.warn(
          `Unable to reliably read Roborock schedules for ${this.duid}: ` +
            `get_server_timer returned ${typeof raw}; preserving existing schedules.`
        );
        return {
          success: false,
          hasSchedules: this.scheduleAccessories.size > 0,
        };
      }

      const schedules = parseServerTimers(raw);

      if (this.disposed) {
        return {
          success: false,
          hasSchedules: false,
        };
      }

      // Keep display numbering stable even if Roborock returns schedules
      // in a different order between refreshes.
      schedules.sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      );

      // A non-empty response that parses to zero schedules is not a
      // trustworthy empty snapshot. Preserve the previous state instead
      // of deleting every HomeKit schedule switch.
      if (raw.length > 0 && schedules.length === 0) {
        if (generation !== this.refreshGeneration || this.disposed) {
          return {
            success: false,
            hasSchedules: this.scheduleAccessories.size > 0,
          };
        }

        this.recordRefreshFailure();
        this.platform.log.warn(
          `Unable to reliably read Roborock schedules for ${this.duid}: ` +
            `get_server_timer returned a non-empty response that parsed to zero schedules; preserving existing schedules.`
        );
        return {
          success: false,
          hasSchedules: this.scheduleAccessories.size > 0,
        };
      }

      // A newer refresh may have started while this request was in flight.
      // The older request may finish, but it must never overwrite the newer
      // snapshot or its refresh timestamps.
      if (generation !== this.refreshGeneration || this.disposed) {
        return {
          success: false,
          hasSchedules: this.scheduleAccessories.size > 0,
        };
      }

      this.cachedSchedules = schedules.map((schedule) => ({
        ...schedule,
        timer: [...schedule.timer],
      }));
      this.lastScheduleRefreshAt = Date.now();
      this.clearRefreshFailure();

      this.platform.log.info(
        `Schedule parser: parsed ${this.duid}; result count=${schedules.length}.`
      );

      this.sync(schedules);

      // A successful empty snapshot is authoritative information. It is
      // different from a failed/untrusted cloud response.
      return {
        success: true,
        hasSchedules: schedules.length > 0,
      };
    } catch (error) {
      if (generation !== this.refreshGeneration || this.disposed) {
        return {
          success: false,
          hasSchedules: this.scheduleAccessories.size > 0,
        };
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
      return {
        success: false,
        hasSchedules: this.scheduleAccessories.size > 0,
      };
    }
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
        await updateServerTimer(
          api,
          this.duid,
          request.scheduleId,
          request.enabled,
          { requestTimeoutMs: 10000 }
        );
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

    const fallback = primarySent.filter(
      (request) => !this.cachedScheduleMatches(request)
    );
    const primaryConfirmed = primarySent.length - fallback.length;
    this.platform.log.info(
      `Schedule batch verification for ${this.duid}: ` +
        `requested=${requests.length}; primarySent=${primarySent.length}; ` +
        `primaryConfirmed=${primaryConfirmed}; fallbackNeeded=${fallback.length}.`
    );
    for (const request of primarySent) {
      if (!fallback.includes(request)) {
        failures.delete(request.scheduleId);
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
    this.stopRuntime();

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
    this.cachedSchedules = undefined;
    this.lastScheduleRefreshAt = 0;
    this.clearRefreshFailure();
    this.writeBatcher.cancelPending();

    for (const schedule of this.scheduleAccessories.values()) {
      schedule.dispose();
    }

    this.scheduleAccessories.clear();
  }

  private sync(schedules: RoborockSchedule[]): void {
    this.platform.log.debug(
      `Schedule sync: ${this.duid} received ${schedules.length} parsed schedule(s).`
    );

    const ids = new Set(schedules.map((schedule) => schedule.id));

    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      const displayName = `${this.vacuumName} Schedule ${i + 1}`;
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
