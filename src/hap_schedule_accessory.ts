import { PlatformAccessory } from "homebridge";
import RoborockPlatform from "./platform";
import {
  getServerTimers,
  updateServerTimer,
  updateTimer,
} from "./hap_schedule_api";
import { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME } from "./settings";
import { scheduleTimer, unrefTimer } from "./timers";

const VERIFY_DELAY_MS = 3000;
const WRITE_SUPPRESSION_MS = 5000;
const SCHEDULE_CACHE_TTL_MS = 60 * 1000;
const SCHEDULE_FAILURE_BACKOFF_MS = 30 * 1000;
const SERVICE_PREFIX = "roborock-schedule-";

export const HAP_EXTENSION_KIND = "hapExtension" as const;
export const HAP_SCHEDULE_EXTENSION = "schedules" as const;

export interface HapScheduleContext {
  kind: typeof HAP_EXTENSION_KIND;
  extension: typeof HAP_SCHEDULE_EXTENSION;
  duid: string;
  scheduleId?: string;
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
 * Each Roborock timer is exposed as its own HAP switch accessory.
 *
 * Schedule accessories are intentionally named from the vacuum name so the
 * Home app presents the schedules together under the vacuum's schedule
 * grouping:
 *
 *   <vacuum> Schedule 1
 *   <vacuum> Schedule 2
 *   ...
 *
 * The schedule ID remains part of the accessory UUID/context and is therefore
 * stable even if the displayed name changes.
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
  private refreshInProgress: Promise<RoborockScheduleRefreshResult> | undefined;
  private refreshInProgressStartedAt = 0;
  private refreshGeneration = 0;

  constructor(
    private readonly platform: RoborockPlatform,
    accessory: PlatformAccessory,
    private readonly duid: string
  ) {
    this.managerAccessory = accessory;
    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid,
    } satisfies HapScheduleContext;
  }

  async initialize(vacuumName: string): Promise<RoborockScheduleRefreshResult> {
    this.vacuumName = vacuumName;

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
        `lastFailureAgeMs=${this.lastFailedRefreshAt > 0 ? now - this.lastFailedRefreshAt : "never"}`
    );

    if (
      this.cachedSchedules !== undefined &&
      now - this.lastScheduleRefreshAt < SCHEDULE_CACHE_TTL_MS
    ) {
      this.platform.log.debug(
        `Schedule refreshIfNeeded: CACHE HIT; ` +
          `ageMs=${now - this.lastScheduleRefreshAt}; ` +
          `returning=${this.cachedSchedules.length > 0}`
      );
      return this.cachedSchedules.length > 0;
    }

    if (
      this.lastFailedRefreshAt > 0 &&
      now - this.lastFailedRefreshAt < SCHEDULE_FAILURE_BACKOFF_MS
    ) {
      this.platform.log.debug(
        `Schedule refreshIfNeeded: FAILURE BACKOFF; ` +
          `ageMs=${now - this.lastFailedRefreshAt}; ` +
          `returning=${(this.cachedSchedules?.length ?? 0) > 0}`
      );
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
    minimumRefreshStartedAt = 0
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

    const refresh = this.performRefresh(generation);

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
    generation: number
  ): Promise<RoborockScheduleRefreshResult> {
    try {
      const api = this.platform.roborockAPI as any;
      const raw = await getServerTimers(api, this.duid, {
        requestTimeoutMs: 10000,
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

        this.lastFailedRefreshAt = Date.now();
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

        this.lastFailedRefreshAt = Date.now();
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
      this.lastFailedRefreshAt = 0;

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

      this.lastFailedRefreshAt = Date.now();
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

  dispose(): void {
    this.disposed = true;
    this.refreshGeneration++;
    this.refreshInProgress = undefined;
    this.refreshInProgressStartedAt = 0;
    this.cachedSchedules = undefined;
    this.lastScheduleRefreshAt = 0;

    for (const schedule of this.scheduleAccessories.values()) {
      schedule.dispose();
    }

    this.scheduleAccessories.clear();

    // Keep the manager accessory registered so it can be rebuilt
    // when schedules are enabled again.
    for (const service of [...this.managerAccessory.services]) {
      if (service.UUID === this.platform.Service.Switch.UUID) {
        this.managerAccessory.removeService(service);
      }
    }

    this.platform.api.updatePlatformAccessories([this.managerAccessory]);
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
  private readonly writes = new Set<string>();
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

    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid,
      scheduleId,
    } satisfies HapScheduleContext;
  }

  initialize(displayName: string, schedule: RoborockSchedule): void {
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
    const previousAccessoryName = this.accessory.displayName;
    this.schedule = { ...schedule, timer: [...schedule.timer] };
    this.accessory.displayName = displayName;

    const switchService = this.accessory.getServiceById(
      this.platform.Service.Switch,
      `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`
    );
    if (switchService) {
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
        String(currentConfiguredName) === previousAccessoryName
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
    this.writes.clear();
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

    if (this.writes.has(this.scheduleId)) {
      this.updateService(previous);
      return;
    }

    this.writes.add(this.scheduleId);

    try {
      const api = this.platform.roborockAPI as any;

      this.platform.log.info(
        `Schedule command: ${enabled ? "enabling" : "disabling"} ${this.duid}/${this.scheduleId}; params=[[${JSON.stringify(this.scheduleId)}, ${JSON.stringify(enabled ? "on" : "off")}]].`
      );

      const writeStartedAt = Date.now();

      await updateServerTimer(api, this.duid, this.scheduleId, enabled, {
        requestTimeoutMs: 10000,
      });

      if (!(await this.verify(enabled, writeStartedAt))) {
        this.platform.log.warn(
          `Roborock schedule ${this.scheduleId} did not reflect upd_server_timer; trying upd_timer fallback.`
        );

        const fallbackWriteStartedAt = Date.now();

        await updateTimer(api, this.duid, this.scheduleId, enabled, {
          requestTimeoutMs: 10000,
        });

        if (!(await this.verify(enabled, fallbackWriteStartedAt))) {
          throw new Error(
            `Roborock did not confirm schedule ${this.scheduleId} as ${enabled ? "enabled" : "disabled"}`
          );
        }
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
    } finally {
      this.writes.delete(this.scheduleId);
    }
  }

  private async verify(
    enabled: boolean,
    minimumRefreshStartedAt: number
  ): Promise<boolean> {
    await new Promise<void>((resolve) => {
      const timer = scheduleTimer(resolve, VERIFY_DELAY_MS);
      unrefTimer(timer);
    });

    const current = await this.coordinator.refreshAndGetSchedule(
      this.scheduleId,
      minimumRefreshStartedAt
    );

    if (!current) {
      return false;
    }

    this.schedule = { ...current, timer: [...current.timer] };
    this.updateService(current.enabled);

    return current.enabled === enabled;
  }

  private updateService(enabled: boolean): void {
    const service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`
    );
    service?.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}
