jest.mock("../src/hap_schedule_accessory", () => {
  const instances = [];

  class FakeScheduleAccessory {
    constructor(platform, accessory, duid) {
      this.platform = platform;
      this.managerAccessory = accessory;
      this.duid = duid;
      this.initialize = jest.fn().mockResolvedValue({
        success: false,
        hasSchedules: false,
      });
      this.restoreScheduleHandlersFromAccessory = jest
        .fn()
        .mockReturnValue(true);

      instances.push(this);
    }
  }

  return {
    __esModule: true,
    default: FakeScheduleAccessory,
    isHapScheduleAccessory: (accessory) =>
      typeof accessory?.context?.duid === "string" &&
      accessory.context.duid.length > 0,
    __instances: instances,
  };
});

const RoborockPlatform = require("../src/platform").default;

function makeHarness() {
  const cachedAccessory = {
    UUID: "schedule-uuid-device-1",
    displayName: "Test Robot Schedules",
    context: {
      duid: "device-1",
      kind: "hap",
      extension: "schedules",
    },
  };

  const platform = Object.create(RoborockPlatform.prototype);

  platform.platformConfig = {
    enableHomeKitActionSwitches: true,
    enableHomeKitScheduleSwitches: true,
  };

  platform.accessories = [cachedAccessory];
  platform.hapScheduleAccessories = new Map();
  platform.scheduleAccountCoordinator = {
    policyDescription: jest.fn().mockReturnValue("Schedule cloud policy"),
  };
  platform.schedulePolicyLogged = false;

  platform.log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  platform.api = {
    hap: {
      uuid: {
        generate: jest.fn((seed) =>
          seed === "hap:roborock:schedules:device-1"
            ? "schedule-uuid-device-1"
            : seed
        ),
      },
    },
    unregisterPlatformAccessories: jest.fn(),
    registerPlatformAccessories: jest.fn(),
  };

  platform.getVacuumDisplayName = jest.fn(() => "Test Robot");
  platform.removeHapScheduleAccessory = jest.fn();

  return {
    platform,
    cachedAccessory,
  };
}

describe("HAP schedule startup recovery", () => {
  test("failed startup refresh restores the cached schedule coordinator", async () => {
    const { platform, cachedAccessory } = makeHarness();

    platform.syncHapSchedules([{ duid: "device-1" }]);

    await Promise.resolve();
    await Promise.resolve();

    expect(platform.hapScheduleAccessories.has("device-1")).toBe(true);

    const coordinator = platform.hapScheduleAccessories.get("device-1");

    expect(coordinator.initialize).toHaveBeenCalledWith("Test Robot");
    expect(
      coordinator.restoreScheduleHandlersFromAccessory
    ).toHaveBeenCalledTimes(1);

    expect(platform.accessories).toContain(cachedAccessory);

    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });
});
