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

    expect(items.enum).toEqual(["clean", "dock", "pause", "locate"]);

    expect(items.oneOf.some((entry) => entry.enum?.[0] === "schedules")).toBe(
      false
    );
  });

  test("the settings page has a dedicated schedule checkbox", () => {
    expect(uiJs).toContain("homeKitActionSchedules: document.getElementById(");
    expect(uiJs).toContain('"homekit-action-schedules"');
    expect(uiHtml).toContain('id="homekit-action-schedules"');
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
    expect(disabledBlock[1]).toContain("schedule.dispose()");
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

  test("schedule refresh uses a 60-second cache and no permanent polling", () => {
    expect(scheduleSource).toMatch(/const SCHEDULE_CACHE_TTL_MS = 60 \* 1000;/);

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
      /const refresh = this\.performRefresh\(generation\);[\s\S]*?this\.refreshInProgress = refresh;/
    );

    expect(scheduleSource).toMatch(
      /const raw = await getServerTimers\(api, this\.duid, \{/
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
      /if \(raw\.length > 0 && schedules\.length === 0\) \{[\s\S]*?lastFailedRefreshAt = Date\.now\(\);[\s\S]*?preserving existing schedules/
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

  test("schedule refresh preserves a HomeKit ConfiguredName", () => {
    expect(scheduleSource).toContain(
      "const previousAccessoryName = this.accessory.displayName;"
    );
    expect(scheduleSource).toContain(
      "const currentConfiguredName = configuredName.value;"
    );
    expect(scheduleSource).toContain(
      "String(currentConfiguredName) === previousAccessoryName"
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

  test("schedule writes capture a timestamp before each actual cloud write", () => {
    expect(scheduleSource).toContain("const writeStartedAt = Date.now();");
    expect(scheduleSource).toContain(
      "const fallbackWriteStartedAt = Date.now();"
    );
    expect(scheduleSource).toContain("this.verify(enabled, writeStartedAt)");
    expect(scheduleSource).toContain(
      "this.verify(enabled, fallbackWriteStartedAt)"
    );
  });

  test("failure backoff is debug-level", () => {
    const start = scheduleSource.indexOf("this.lastFailedRefreshAt > 0 &&");
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
      'import { scheduleTimer, unrefTimer } from "./timers";'
    );
    expect(scheduleSource).toContain(
      "const timer = scheduleTimer(resolve, VERIFY_DELAY_MS);"
    );
    expect(scheduleSource).toContain("unrefTimer(timer);");
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

  test("schedule verification refreshes through the coordinator", () => {
    expect(scheduleSource).toContain("this.coordinator.refreshAndGetSchedule(");
    expect(scheduleSource).toContain(
      "const current = await this.coordinator.refreshAndGetSchedule("
    );
    expect(scheduleSource).toContain(
      "this.schedule = { ...current, timer: [...current.timer] };"
    );
    expect(scheduleSource).toContain("return current.enabled === enabled;");
  });

  test("verified schedule writes use the coordinator snapshot", () => {
    expect(scheduleSource).toContain(
      "const current = await this.coordinator.refreshAndGetSchedule("
    );
    expect(scheduleSource).toContain(
      "this.schedule = { ...current, timer: [...current.timer] };"
    );
    expect(scheduleSource).toContain("this.updateService(current.enabled);");
  });

  test("disposed schedule coordinators cannot sync an in-flight refresh", () => {
    expect(scheduleSource).toContain("private disposed = false;");
    expect(scheduleSource).toContain("if (this.disposed) {");
    expect(scheduleSource).toContain("this.disposed = true;");
  });

  test("schedule dispose removes dynamic services but preserves manager", () => {
    expect(scheduleSource).toMatch(
      /dispose\(\): void \{[\s\S]*?removeService\(service\)[\s\S]*?updatePlatformAccessories/
    );

    const disposeBlock = scheduleSource.match(
      /dispose\(\): void \{([\s\S]*?)\n\s*\}/
    );

    expect(disposeBlock).not.toBeNull();
    expect(disposeBlock[1]).not.toContain("unregisterPlatformAccessories");
  });
});
