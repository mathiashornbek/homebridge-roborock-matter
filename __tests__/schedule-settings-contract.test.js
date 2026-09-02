"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

const schema = JSON.parse(read("config.schema.json"));
const uiJs = read("homebridge-ui", "public", "index.js");
const uiHtml = read("homebridge-ui", "public", "index.html");
const platformSource = read("src", "platform.ts");
const typesSource = read("src", "types.ts");
const scheduleSource = read("src", "hap_schedule_accessory.ts");

describe("HomeKit schedule settings contract", () => {
  test("schedules are a separate config setting, not an action key", () => {
    expect(typesSource).toContain("enableHomeKitScheduleSwitches?: boolean;");

    const items = schema.schema.properties.homeKitActionSwitches.items;

    expect(items.enum).toEqual(["clean", "dock", "empty", "pause", "locate"]);

    expect(items.oneOf.some((entry) => entry.enum?.[0] === "schedules")).toBe(
      false
    );
  });

  test("the settings page has a dedicated schedule checkbox", () => {
    expect(uiJs).toContain("homeKitActionSchedules: document.getElementById(");
    expect(uiJs).toContain('"homekit-action-schedules"');
    expect(uiHtml).toContain('id="homekit-action-schedules"');
  });

  test("schedule cloud policy keeps internal defaults out of user configuration", () => {
    const removedKeys = [
      "scheduleRefreshIntervalMinutes",
      "scheduleBatchWindowMilliseconds",
      "scheduleWriteSpacingMilliseconds",
      "scheduleRateLimitCooldownMinutes",
    ];

    for (const key of removedKeys) {
      expect(typesSource).not.toContain(`${key}?: number;`);
      expect(schema.schema.properties[key]).toBeUndefined();
      expect(uiJs).not.toContain(key);
      expect(platformSource).not.toContain(`this.platformConfig.${key}`);
    }

    expect(uiHtml).not.toContain("schedule-refresh-interval-minutes");
    expect(uiHtml).not.toContain("schedule-batch-window-milliseconds");
    expect(uiHtml).not.toContain("schedule-write-spacing-milliseconds");
    expect(uiHtml).not.toContain("schedule-rate-limit-cooldown-minutes");
    expect(platformSource).toContain("new ScheduleAccountCoordinator()");
    expect(scheduleSource).toMatch(
      /cacheTtlMs: SCHEDULE_CACHE_TTL_MS,[\s\S]*?batchWindowMs: SCHEDULE_WRITE_BATCH_WINDOW_MS,[\s\S]*?writeSpacingMs: SCHEDULE_WRITE_SPACING_MS,[\s\S]*?throttleCooldownMs: SCHEDULE_THROTTLE_COOLDOWN_MS/
    );
  });

  test("the schedule checkbox is loaded from saved config", () => {
    expect(uiJs).toMatch(
      /elements\.homeKitActionSchedules\.checked\s*=\s*Boolean\(\s*config\.enableHomeKitScheduleSwitches\s*\)/
    );
  });

  test("Save Settings persists the schedule checkbox", () => {
    expect(uiJs).toMatch(
      /enableHomeKitScheduleSwitches:\s*Boolean\(\s*elements\.homeKitActionSchedules\?\.checked\s*\)/
    );

    expect(uiJs).toMatch(
      /elements\.saveFeatureSettings\.addEventListener\("click",[\s\S]*?handleSaveClick\(elements\.saveFeatureSettings\)/
    );

    expect(uiJs).toContain(
      "await window.homebridge.updatePluginConfig(configs);"
    );
    expect(uiJs).toContain("await window.homebridge.savePluginConfig();");
  });

  test("schedule changes are not auto-saved by the checkbox itself", () => {
    const scheduleCheckboxSection = uiJs.slice(
      uiJs.indexOf("elements.homeKitActionSchedules"),
      uiJs.indexOf("elements.homeKitActionSchedules") + 2500
    );

    expect(scheduleCheckboxSection).not.toContain(
      'addEventListener("change", () => autoSave())'
    );
  });

  test("runtime schedule exposure requires both the master and schedule settings", () => {
    expect(platformSource).toMatch(
      /private shouldExposeHapSchedules\(\): boolean \{[\s\S]*?enableHomeKitActionSwitches === true[\s\S]*?enableHomeKitScheduleSwitches === true[\s\S]*?\}/
    );
  });

  test("master-off schedule removal unregisters all schedule accessories", () => {
    expect(platformSource).toMatch(
      /private removeHapScheduleAccessories\(\): void \{[\s\S]*?hapScheduleAccessories\.clear\(\)[\s\S]*?unregisterPlatformAccessories/
    );

    expect(platformSource).toMatch(
      /if \(!this\.platformConfig\.enableHomeKitActionSwitches\) \{[\s\S]*?removeHapScheduleAccessories\(\)[\s\S]*?return;/
    );
  });

  test("schedule-only disable preserves the cached coordinator", () => {
    const disabledBlock = platformSource.match(
      /if \(!exposeSchedules\) \{([\s\S]*?)\n\s*return;/
    );

    expect(disabledBlock).not.toBeNull();
    expect(disabledBlock[1]).toContain("schedule.removeScheduleServices()");
    expect(disabledBlock[1]).not.toContain("hapScheduleAccessories.clear()");
  });

  test("schedule accessory Model is the unbranded name Schedules", () => {
    expect(scheduleSource).toContain('"Schedules"');
    expect(scheduleSource).not.toContain('"Roborock Schedules"');
  });

  test("schedule initialization refreshes through the cached coordinator", () => {
    expect(scheduleSource).toContain("async initialize(");
    expect(scheduleSource).toContain(
      "): Promise<RoborockScheduleRefreshResult>"
    );

    expect(scheduleSource).toMatch(
      /Initial discovery always performs one cloud schedule request\.[\s\S]*?return this\.refreshDetailed\(\);/
    );

    expect(scheduleSource).toMatch(
      /async refreshIfNeeded\(\): Promise<boolean>/
    );

    expect(scheduleSource).toContain("return this.cachedSchedules.length > 0;");

    expect(scheduleSource).not.toContain("startPolling");
    expect(scheduleSource).not.toContain("stopPolling");
  });

  test("schedule refresh uses a five-minute cache and no permanent polling", () => {
    expect(scheduleSource).toMatch(
      /const SCHEDULE_CACHE_TTL_MS = 5 \* 60 \* 1000;/
    );

    expect(scheduleSource).toMatch(
      /private cachedSchedules: RoborockSchedule\[\] \| undefined;/
    );

    expect(scheduleSource).toMatch(/private lastScheduleRefreshAt = 0;/);

    expect(scheduleSource).toMatch(
      /private refreshInProgress: Promise<RoborockScheduleRefreshResult> \| undefined;/
    );

    expect(scheduleSource).toMatch(
      /async refreshIfNeeded\(\): Promise<boolean>/
    );

    expect(scheduleSource).toMatch(
      /const refresh = this\.performRefresh\(generation, accountCoordinatorHeld\);[\s\S]*?this\.refreshInProgress = refresh;/
    );

    expect(scheduleSource).toMatch(
      /const readSchedules = \(\) =>[\s\S]*?getServerTimers\(api, this\.duid, \{/
    );

    expect(scheduleSource).not.toContain("SCHEDULE_POLL_INTERVAL_MS");
    expect(scheduleSource).not.toContain("setInterval(");
    expect(scheduleSource).not.toContain("startPolling");
    expect(scheduleSource).not.toContain("stopPolling");
  });

  test("restored schedule groups preserve accessories when initial refresh fails", () => {
    expect(platformSource).toMatch(
      /if \(schedule\) \{[\s\S]*?\.initialize\(target\.vacuumName\)[\s\S]*?if \(!result\.success\) \{[\s\S]*?restoreScheduleHandlersFromAccessory\(\)[\s\S]*?return;/
    );
  });

  test("first-time schedule creation requires a successful non-empty snapshot", () => {
    expect(platformSource).toMatch(
      /\.initialize\(target\.vacuumName\)[\s\S]*?if \(!result\.success\) \{[\s\S]*?this\.hapScheduleAccessories\.delete\(duid\);[\s\S]*?if \(!result\.hasSchedules\) \{/
    );
  });

  test("failed restored schedule discovery does not unregister the cached accessory", () => {
    const start = platformSource.indexOf("if (!result.success) {");
    const end = platformSource.indexOf(
      "const accessory = this.accessories.find(",
      start
    );
    const failureBlock = platformSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    expect(failureBlock).toContain("restoreScheduleHandlersFromAccessory()");
    expect(failureBlock).not.toContain(
      "removeHapScheduleAccessory(duid, accessory)"
    );
  });

  test("non-empty unparsable schedule responses are treated as untrusted", () => {
    expect(scheduleSource).toMatch(
      /if \(raw\.length > 0 && schedules\.length === 0\) \{[\s\S]*?this\.recordRefreshFailure\(\);[\s\S]*?preserving existing schedules/
    );
  });

  test("schedule ordering is deterministic by schedule ID", () => {
    expect(scheduleSource).toContain("schedules.sort((a, b) =>");
    expect(scheduleSource).toContain(
      "a.id.localeCompare(b.id, undefined, { numeric: true })"
    );
  });

  test("schedule child initialization does not overwrite a restored ConfiguredName", () => {
    expect(scheduleSource).toContain(
      "const currentConfiguredName = configuredName.value;"
    );
    expect(scheduleSource).toContain(
      "String(currentConfiguredName) === displayName"
    );
    expect(scheduleSource).toContain("configuredName.setValue(displayName);");
  });

  test("schedule refresh preserves a custom HomeKit ConfiguredName", () => {
    expect(scheduleSource).toContain(
      "const previousServiceName = switchService.getCharacteristic("
    );
    expect(scheduleSource).toContain(
      "const currentConfiguredName = configuredName.value;"
    );
    expect(scheduleSource).toContain(
      "String(currentConfiguredName) === String(previousServiceName)"
    );
    expect(scheduleSource).not.toContain(
      "this.accessory.displayName = displayName;"
    );
  });

  test("schedule verification requires a refresh started at or after the write", () => {
    expect(scheduleSource).toContain("private refreshInProgressStartedAt = 0;");
    expect(scheduleSource).toContain("private refreshGeneration = 0;");
    expect(scheduleSource).toContain("minimumRefreshStartedAt = 0");
    expect(scheduleSource).toContain(
      "this.refreshInProgressStartedAt >= minimumRefreshStartedAt"
    );
    expect(scheduleSource).toContain("generation !== this.refreshGeneration");
  });

  test("schedule batches capture a timestamp before each verification phase", () => {
    expect(scheduleSource).toContain("const primaryStartedAt = Date.now();");
    expect(scheduleSource).toContain("const fallbackStartedAt = Date.now();");
    expect(scheduleSource).toContain(
      "await this.refreshDetailed(primaryStartedAt, true);"
    );
    expect(scheduleSource).toContain(
      "await this.refreshDetailed(fallbackStartedAt, true);"
    );
  });

  test("schedule writes are serialized by the per-vacuum coordinator", () => {
    expect(scheduleSource).toContain(
      "new ScheduleWriteBatcher<ScheduleWriteRequest>("
    );
    expect(scheduleSource).toContain(
      "const executed = await this.coordinator.enqueueScheduleWrite("
    );
    expect(scheduleSource).toMatch(
      /private stopRuntime\(\): void \{[\s\S]*?this\.writeBatcher\.cancelPending\(\);/
    );
  });

  test("failure backoff is debug-level", () => {
    const start = scheduleSource.indexOf(
      "(this.nextRefreshAttemptAt || 0) > now"
    );
    const end = scheduleSource.indexOf(
      "this.platform.log.debug(`Schedule refreshIfNeeded: CALLING refresh()`);",
      start
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const block = scheduleSource.slice(start, end);

    expect(block).toContain("this.platform.log.debug(");
    expect(block).toContain("Schedule refreshIfNeeded: FAILURE BACKOFF;");
    expect(block).not.toContain("this.platform.log.info(");
  });

  test("schedule verification uses the shared timer utility", () => {
    expect(scheduleSource).toContain(
      'import { clearTimer, scheduleTimer, unrefTimer } from "./timers";'
    );
    expect(scheduleSource).toContain(
      "const timer = scheduleTimer(resolve, VERIFY_DELAY_MS);"
    );
    expect(scheduleSource).toContain("unrefTimer(timer);");
  });

  test("distinct schedule writes are conservatively spaced", () => {
    expect(scheduleSource).toContain("const SCHEDULE_WRITE_SPACING_MS = 500;");
    expect(scheduleSource).toContain(
      "await this.waitForScheduleWriteSpacing();"
    );
    expect(scheduleSource).toContain(
      "this.accountCoordinator.policy.writeSpacingMs"
    );
  });

  test("definite throttling stops pending schedule traffic", () => {
    expect(scheduleSource).toContain(
      "export function isDefiniteScheduleThrottle(error: unknown): boolean"
    );
    expect(scheduleSource).toContain(
      "const SCHEDULE_THROTTLE_COOLDOWN_MS = 65 * 60 * 1000;"
    );
    expect(scheduleSource).toContain("this.recordScheduleThrottle(error);");
    expect(scheduleSource).toContain(
      "this.accountCoordinator.recordThrottle(error);"
    );
    expect(scheduleSource).toContain(
      "this.accountCoordinator.currentThrottleError()"
    );
  });

  test("all vacuum schedule batches share the platform account coordinator", () => {
    expect(scheduleSource).toContain("export class ScheduleAccountCoordinator");
    expect(platformSource).toContain(
      "private readonly scheduleAccountCoordinator: ScheduleAccountCoordinator;"
    );
    expect(platformSource).toContain(
      "this.scheduleAccountCoordinator = new ScheduleAccountCoordinator();"
    );
    expect(platformSource).toContain("this.scheduleAccountCoordinator");
    expect(scheduleSource).toContain(
      "const result = await this.accountCoordinator.enqueue("
    );
    expect(scheduleSource).toContain(
      "await this.accountCoordinator.enqueue(readSchedules, (error) => {"
    );
  });

  test("schedule cloud policy and cumulative request totals are observable", () => {
    expect(scheduleSource).toContain("metricsSnapshot():");
    expect(scheduleSource).toContain("Schedule cloud totals: reads=");
    expect(scheduleSource).toContain("primaryWrites=${metrics.primaryWrites}");
    expect(scheduleSource).toContain(
      "fallbackWrites=${metrics.fallbackWrites}"
    );
    expect(scheduleSource).toContain("coalesced=${metrics.coalescedChanges}");
    expect(platformSource).toContain(
      "this.log.info(this.scheduleAccountCoordinator.policyDescription());"
    );
  });

  test("routine schedule cache decisions are debug-level", () => {
    const start = scheduleSource.indexOf(
      "async refreshIfNeeded(): Promise<boolean>"
    );
    const end = scheduleSource.indexOf(
      "  async refresh(): Promise<boolean>",
      start
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const refreshBlock = scheduleSource.slice(start, end);

    expect(refreshBlock).toContain("this.platform.log.debug(");
    expect(refreshBlock).toContain("`Schedule refreshIfNeeded: entered; `");
    expect(refreshBlock).toContain("`Schedule refreshIfNeeded: CACHE HIT; `");
    expect(refreshBlock).toContain(
      "this.platform.log.debug(`Schedule refreshIfNeeded: CALLING refresh()`);"
    );

    const enteredIndex = refreshBlock.indexOf(
      "`Schedule refreshIfNeeded: entered; `"
    );
    const cacheHitIndex = refreshBlock.indexOf(
      "`Schedule refreshIfNeeded: CACHE HIT; `"
    );
    const callRefreshIndex = refreshBlock.indexOf(
      "this.platform.log.debug(`Schedule refreshIfNeeded: CALLING refresh()`);"
    );

    expect(
      refreshBlock.lastIndexOf("this.platform.log.debug(", enteredIndex)
    ).toBeGreaterThanOrEqual(0);

    expect(
      refreshBlock.lastIndexOf("this.platform.log.debug(", cacheHitIndex)
    ).toBeGreaterThanOrEqual(0);

    expect(callRefreshIndex).toBeGreaterThan(0);

    // Failure backoff is intentionally debug-level because every HomeKit read can hit this branch during an outage.
    expect(refreshBlock).toContain("this.platform.log.debug(");
    expect(refreshBlock).toContain(
      "`Schedule refreshIfNeeded: FAILURE BACKOFF; `"
    );
  });

  test("routine schedule payload logging is debug-level", () => {
    expect(scheduleSource).toContain("this.platform.log.debug(");
    expect(scheduleSource).toContain("`Schedule discovery for ${this.duid}: `");
  });

  test("schedule switch GET returns cached state without waiting for refresh", () => {
    expect(scheduleSource).toMatch(
      /\.onGet\(\(\) => \{[\s\S]*?void this\.coordinator\.refreshIfNeeded\(\);[\s\S]*?return this\.schedule\.enabled;/
    );
    expect(scheduleSource).not.toMatch(
      /\.onGet\(async \(\) => \{[\s\S]*?await this\.coordinator\.refreshIfNeeded\(\);/
    );
  });

  test("schedule verification refreshes once per batch through the coordinator", () => {
    expect(scheduleSource).toContain(
      "await this.refreshDetailed(primaryStartedAt, true);"
    );
    expect(scheduleSource).toContain("const fallback = primarySent.filter(");
    expect(scheduleSource).toContain(
      "await this.refreshDetailed(fallbackStartedAt, true);"
    );
    expect(scheduleSource).toContain("this.cachedScheduleMatches(request)");
  });

  test("stopped schedule coordinators cannot sync an in-flight refresh", () => {
    expect(scheduleSource).toContain("private disposed = false;");
    expect(scheduleSource).toContain("if (this.disposed) {");
    expect(scheduleSource).toContain("this.disposed = true;");
  });

  test("normal shutdown preserves schedule services", () => {
    const platformShutdownStart = platformSource.indexOf(
      "this.api.on(APIEvent.SHUTDOWN"
    );
    const platformShutdownEnd = platformSource.indexOf(
      "if (this.roborockAPI)",
      platformShutdownStart
    );
    const platformShutdownBlock = platformSource.slice(
      platformShutdownStart,
      platformShutdownEnd
    );

    expect(platformShutdownStart).toBeGreaterThanOrEqual(0);
    expect(platformShutdownEnd).toBeGreaterThan(platformShutdownStart);
    expect(platformShutdownBlock).toContain("schedule.shutdown()");
    expect(platformShutdownBlock).not.toContain(
      "schedule.removeScheduleServices()"
    );

    expect(scheduleSource).toMatch(
      /shutdown\(\): void \{[\s\S]*?this\.stopRuntime\(\);[\s\S]*?\}/
    );
  });

  test("intentional schedule removal preserves only the manager", () => {
    expect(scheduleSource).toMatch(
      /removeScheduleServices\(\): void \{[\s\S]*?removeService\(service\)[\s\S]*?updatePlatformAccessories/
    );

    const removalBlock = scheduleSource.match(
      /removeScheduleServices\(\): void \{([\s\S]*?)\n\s*\}/
    );

    expect(removalBlock).not.toBeNull();
    expect(removalBlock[1]).not.toContain("unregisterPlatformAccessories");
  });
});
