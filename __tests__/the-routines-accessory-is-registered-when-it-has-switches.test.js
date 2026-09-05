"use strict";

/**
 * The "<robot> Routines" accessory is registered with Homebridge only once
 * it has a switch to show, and unregistered when a trustworthy reading says
 * the account has none — an accessory with nothing on it would otherwise sit
 * in the Home app as a tile that does nothing. The coordinator reports the
 * count after every reading; this pins what the platform does with it, and
 * that the Matter-only sweep leaves the new accessory kind alone.
 */

jest.mock("../src/hap_schedule_accessory", () => {
  const instances = [];

  class FakeScheduleAccessory {
    constructor(platform, accessory, duid) {
      this.platform = platform;
      this.managerAccessory = accessory;
      this.duid = duid;
      this.routineCount = 0;
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
      }
    },
    unregisterPlatformAccessories: jest.fn(),
    registerPlatformAccessories: jest.fn(),
  };
  platform.getVacuumDisplayName = jest.fn(() => "Rocky");

  return platform;
}

beforeEach(() => {
  __instances.length = 0;
});

describe("routine accessory registration", () => {
  test("a fresh accessory is registered on the first reading that has switches, and unregistered when they are gone", async () => {
    const platform = makePlatform();

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();

    const [coordinator] = __instances;
    expect(coordinator.attachRoutineAccessory).toHaveBeenCalledTimes(1);
    const accessory = coordinator.routineAccessory;
    expect(accessory.displayName).toBe("Rocky Routines");
    expect(accessory.UUID).toBe("uuid:hap:roborock:routines:device-1");
    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();

    coordinator.onCount(2);
    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [accessory]
    );
    expect(platform.accessories).toContain(accessory);

    // The same count again registers nothing twice.
    coordinator.onCount(2);
    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);

    coordinator.onCount(0);
    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [accessory]
    );
    expect(platform.accessories).not.toContain(accessory);
  });

  test("a cached accessory is handed back to the coordinator rather than replaced", async () => {
    const cached = {
      UUID: "uuid:hap:roborock:routines:device-1",
      displayName: "Rocky Routines",
      context: {
        kind: "hapExtension",
        extension: "routines",
        duid: "device-1",
      },
    };
    const platform = makePlatform({ cached: [cached] });

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();

    const [coordinator] = __instances;
    expect(coordinator.routineAccessory).toBe(cached);

    // Already registered: a count only keeps the book, no second registration.
    coordinator.onCount(1);
    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  test("with the setting off, cached routine accessories are unregistered and none is attached", async () => {
    const cached = {
      UUID: "uuid:hap:roborock:routines:device-1",
      displayName: "Rocky Routines",
      context: {
        kind: "hapExtension",
        extension: "routines",
        duid: "device-1",
      },
    };
    const platform = makePlatform({ routines: false, cached: [cached] });

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();

    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [cached]
    );
    expect(platform.accessories).not.toContain(cached);
    const [coordinator] = __instances;
    expect(coordinator.attachRoutineAccessory).not.toHaveBeenCalled();
  });

  test("routines alone still create the coordinator, with the schedule half switched off", async () => {
    const platform = makePlatform({ schedules: false });

    platform.syncHapSchedules([{ duid: "device-1" }]);
    await Promise.resolve();

    const [coordinator] = __instances;
    expect(coordinator).toBeDefined();
    expect(coordinator.setScheduleExposure).toHaveBeenCalledWith(false);
    expect(coordinator.attachRoutineAccessory).toHaveBeenCalledTimes(1);
    expect(coordinator.initialize).toHaveBeenCalledWith("Rocky");
  });

  test("a coordinator with routines survives an empty schedule reading", async () => {
    const platform = makePlatform();

    platform.syncHapSchedules([{ duid: "device-1" }]);
    const [coordinator] = __instances;
    coordinator.routineCount = 1;
    await Promise.resolve();
    await Promise.resolve();

    expect(platform.hapScheduleAccessories.get("device-1")).toBe(coordinator);
  });

  test("the Matter-only sweep leaves routine accessories alone", () => {
    const routineAccessory = {
      context: { kind: "hapExtension", extension: "routines", duid: "d" },
    };
    const legacy = { context: {} };
    const platform = makePlatform({ cached: [routineAccessory, legacy] });

    platform.removeLegacyHomeKitAccessories();

    expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [legacy]
    );
    expect(platform.accessories).toContain(routineAccessory);
  });
});
