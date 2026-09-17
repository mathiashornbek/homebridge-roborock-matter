"use strict";

/**
 * ISSUE #22, in the reporter's words: "When unchecking schedules / routines,
 * the cache does not get deleted. So, although unchecked, tiles still appear
 * in HomeKit." And, separately: "initially I had schedules checked. Then I
 * checked routines and got the error. There were still only tiles for
 * schedules. After that I reset the whole plugin and had tiles for both
 * categories at the same time."
 *
 * Two defects, one root: registration was only ever done on the path that
 * CREATES a coordinator, and unregistration was only ever done for
 * coordinators this run had already built. At startup neither set contains
 * the thing the user is actually looking at — the PlatformAccessory
 * Homebridge restored from its own cache — so a setting change could not
 * reach it in either direction. Resetting the plugin worked because it
 * emptied the cache and forced the creation path.
 *
 * These tests use the cached accessory, not a fresh one, because that is the
 * case that was broken.
 */

jest.mock("../src/hap_schedule_accessory", () => {
  const instances = [];

  class FakeScheduleAccessory {
    constructor(platform, accessory, duid) {
      this.platform = platform;
      this.managerAccessory = accessory;
      this.duid = duid;
      this.routineCount = 0;
      this.scheduleCount = 0;
      this.initialize = jest.fn().mockResolvedValue({
        success: true,
        hasSchedules: false,
      });
      this.restoreScheduleHandlersFromAccessory = jest
        .fn()
        .mockReturnValue(false);
      this.setScheduleExposure = jest.fn();
      this.removeRoutineServices = jest.fn();
      this.removeScheduleServices = jest.fn();
      this.attachRoutineAccessory = jest.fn((accessory, onCount) => {
        this.routineAccessory = accessory;
        this.onCount = onCount;
      });
      instances.push(this);
    }

    get scheduleAccessory() {
      return this.managerAccessory;
    }
  }

  return {
    __esModule: true,
    default: FakeScheduleAccessory,
    isHapScheduleAccessory: (accessory) =>
      accessory?.context?.extension === "schedules",
    isHapRoutineAccessory: (accessory) =>
      accessory?.context?.extension === "routines",
    __instances: instances,
  };
});

const RoborockPlatform = require("../src/platform").default;
const { __instances } = require("../src/hap_schedule_accessory");

/** What Homebridge hands back from its cache on the next restart. */
function cachedAccessory(extension, duid = "device-1") {
  return {
    displayName:
      extension === "routines" ? "Rocky Routines" : "Rocky schedules",
    UUID: `uuid:hap:roborock:${extension}:${duid}`,
    context: { kind: "hap-extension", extension, duid },
    services: [],
  };
}

function makePlatform({ routines = true, schedules = true, cached = [] } = {}) {
  const platform = Object.create(RoborockPlatform.prototype);

  platform.platformConfig = {
    enableHomeKitActionSwitches: true,
    enableHomeKitScheduleSwitches: schedules,
    enableHomeKitRoutineSwitches: routines,
  };
  platform.accessories = [...cached];
  platform.hapScheduleAccessories = new Map();
  platform.scheduleAccountCoordinator = {
    policyDescription: jest.fn().mockReturnValue("Schedule cloud policy"),
  };
  platform.schedulePolicyLogged = true;
  platform.log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  platform.api = {
    hap: { uuid: { generate: jest.fn((seed) => `uuid:${seed}`) } },
    platformAccessory: class {
      constructor(displayName, uuid) {
        this.displayName = displayName;
        this.UUID = uuid;
        this.context = {};
        this.services = [];
      }
    },
    unregisterPlatformAccessories: jest.fn(),
    registerPlatformAccessories: jest.fn(),
    updatePlatformAccessories: jest.fn(),
  };
  platform.getVacuumDisplayName = jest.fn(() => "Rocky");

  return platform;
}

const unregistered = (platform) =>
  platform.api.unregisterPlatformAccessories.mock.calls.flatMap(
    (call) => call[2]
  );

beforeEach(() => {
  __instances.length = 0;
});

describe("unchecking the setting takes the tiles with it", () => {
  test("schedules off unregisters the schedule accessory Homebridge restored", () => {
    const schedules = cachedAccessory("schedules");
    const platform = makePlatform({
      schedules: false,
      routines: false,
      cached: [schedules],
    });

    platform.syncHapSchedules([{ duid: "device-1" }]);

    expect(unregistered(platform)).toContain(schedules);
    expect(platform.accessories).not.toContain(schedules);
  });

  test("schedules off does not take the Routines with it", () => {
    const schedules = cachedAccessory("schedules");
    const routines = cachedAccessory("routines");
    const platform = makePlatform({
      schedules: false,
      routines: true,
      cached: [schedules, routines],
    });

    platform.syncHapSchedules([{ duid: "device-1" }]);

    expect(unregistered(platform)).toContain(schedules);
    expect(unregistered(platform)).not.toContain(routines);
    expect(platform.accessories).toContain(routines);
  });

  test("routines off does not take the schedules with it", () => {
    const schedules = cachedAccessory("schedules");
    const routines = cachedAccessory("routines");
    const platform = makePlatform({
      schedules: true,
      routines: false,
      cached: [schedules, routines],
    });

    platform.syncHapSchedules([{ duid: "device-1" }]);

    expect(unregistered(platform)).toContain(routines);
    expect(unregistered(platform)).not.toContain(schedules);
  });

  test("both off removes both, and says so rather than going quiet", () => {
    const schedules = cachedAccessory("schedules");
    const routines = cachedAccessory("routines");
    const platform = makePlatform({
      schedules: false,
      routines: false,
      cached: [schedules, routines],
    });

    platform.syncHapSchedules([{ duid: "device-1" }]);

    const gone = unregistered(platform);
    expect(gone).toContain(schedules);
    expect(gone).toContain(routines);
    expect(platform.accessories).toHaveLength(0);
    expect(
      platform.log.info.mock.calls.some(([line]) =>
        /switched off in the plugin settings/.test(String(line))
      )
    ).toBe(true);
  });

  test("with nothing cached it stays silent — no line about removing nothing", () => {
    const platform = makePlatform({ schedules: false, routines: false });

    platform.syncHapSchedules([{ duid: "device-1" }]);

    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(
      platform.log.info.mock.calls.some(([line]) =>
        /Removing .* HAP schedule/.test(String(line))
      )
    ).toBe(false);
  });
});

describe("checking it again puts them back", () => {
  test("a surviving coordinator re-registers its accessory once it has switches", async () => {
    const platform = makePlatform();

    // First sync builds the coordinator and publishes nothing: no schedules.
    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();

    const [coordinator] = __instances;
    // The coordinator survives because it drives Routines.
    coordinator.routineCount = 2;
    platform.hapScheduleAccessories.set("device-1", coordinator);

    // The user unchecks schedules: the accessory leaves the bridge.
    platform.platformConfig.enableHomeKitScheduleSwitches = false;
    platform.syncHapSchedules([{ duid: "device-1" }]);
    expect(platform.accessories).not.toContain(coordinator.managerAccessory);
    expect(coordinator.removeScheduleServices).toHaveBeenCalled();
    expect(platform.hapScheduleAccessories.get("device-1")).toBe(coordinator);

    // …and back on. The reuse path now has to publish it again, which is the
    // half that never existed: before this, switches were added to an
    // accessory the bridge no longer knew about.
    platform.api.registerPlatformAccessories.mockClear();
    platform.platformConfig.enableHomeKitScheduleSwitches = true;
    coordinator.scheduleCount = 3;
    coordinator.initialize.mockResolvedValue({
      success: true,
      hasSchedules: true,
    });

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [coordinator.managerAccessory]
    );
    expect(platform.accessories).toContain(coordinator.managerAccessory);
  });

  test("it does not register the same accessory twice", async () => {
    const cached = cachedAccessory("schedules");
    const platform = makePlatform({ routines: false, cached: [cached] });

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();

    const [coordinator] = __instances;
    coordinator.scheduleCount = 3;
    coordinator.initialize.mockResolvedValue({
      success: true,
      hasSchedules: true,
    });
    platform.hapScheduleAccessories.set("device-1", coordinator);

    platform.api.registerPlatformAccessories.mockClear();
    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();
    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();

    // It came from the cache, so it is already published: nothing to do.
    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  test("an empty coordinator is not published just because it was asked", async () => {
    const platform = makePlatform({ routines: false });

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();

    const [coordinator] = __instances;
    coordinator.scheduleCount = 0;
    platform.hapScheduleAccessories.set("device-1", coordinator);
    coordinator.initialize.mockResolvedValue({
      success: true,
      hasSchedules: true,
    });

    platform.api.registerPlatformAccessories.mockClear();
    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();
    await Promise.resolve();

    // hasSchedules said yes but there are no switches: an empty tile is
    // exactly what the Routines rule exists to prevent, and it applies here.
    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
  });
});
