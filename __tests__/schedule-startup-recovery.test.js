"use strict";

// A schedule reading that fails as a whole at startup (no source could be
// read) must not cost the user the schedule tiles Homebridge restored: the
// cached switches get their handlers back so a press works meanwhile, the
// cached accessory stays registered, and the coordinator stays to read
// again. The platform used to do the restoring itself and drop the
// coordinator when there was nothing to restore; the coordinator now does
// both halves, and keeps reading until a reading succeeds
// (a-timed-out-timer-read-does-not-withhold-routines.test.js).

const {
  PlatformAccessory,
  hap,
  makeScheduleAccount,
  makeSchedulePlatform,
  switchSubtypes,
} = require("../test-support/schedule-account");
const RoborockPlatform = require("../src/platform").default;

const DUID = "device-1";

describe("HAP schedule startup recovery", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a failed startup reading keeps the cached schedule accessory and gives its switches their handlers", async () => {
    const account = makeScheduleAccount({
      duid: DUID,
      serverTimers: new Error("socket hang up"),
    });
    account.getCloudScenes.mockRejectedValue(new Error("socket hang up"));

    const cached = new PlatformAccessory(
      "Test Robot Schedules",
      hap.uuid.generate(`hap:roborock:schedules:${DUID}`)
    );
    cached.context = {
      kind: "hapExtension",
      extension: "schedules",
      duid: DUID,
    };
    cached.addService(
      hap.Service.Switch,
      "Test Robot Schedule 1",
      "roborock-schedule-timer-2"
    );

    const platform = Object.create(RoborockPlatform.prototype);
    Object.assign(platform, makeSchedulePlatform(account), {
      platformConfig: {
        enableHomeKitActionSwitches: true,
        enableHomeKitScheduleSwitches: true,
      },
      accessories: [cached],
      hapScheduleAccessories: new Map(),
      schedulePolicyLogged: true,
    });
    platform.api = {
      ...platform.api,
      platformAccessory: PlatformAccessory,
      registerPlatformAccessories: jest.fn(),
      unregisterPlatformAccessories: jest.fn(),
    };
    platform.getVacuumDisplayName = () => "Test Robot";

    platform.syncHapSchedules([{ duid: DUID }]);
    await jest.advanceTimersByTimeAsync(0);

    expect(platform.hapScheduleAccessories.has(DUID)).toBe(true);
    expect(platform.accessories).toContain(cached);
    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(switchSubtypes(cached)).toEqual(["roborock-schedule-timer-2"]);
    const on = cached
      .getServiceById(hap.Service.Switch, "roborock-schedule-timer-2")
      .getCharacteristic(hap.Characteristic.On);
    expect(typeof on.setHandler).toBe("function");

    platform.hapScheduleAccessories.get(DUID).shutdown();
  });
});
