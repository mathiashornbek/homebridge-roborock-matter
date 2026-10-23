"use strict";

// A schedule deleted in the Roborock app while Homebridge was stopped kept
// its switch in Apple Home for good. Homebridge restores the switch from its
// cache; the first reading after the restart is authoritative and does not
// list the schedule, but the sync only removed switches it had built in this
// process, so the restored one stayed, with no handler: a press was accepted
// and sent nothing. With no schedule left at all, the coordinator was dropped
// and the accessory kept that dead switch as its only content.
//
// The sync now takes the switches to remove from the accessory itself, and an
// account with no schedules left takes the schedule accessory out of Apple
// Home.

const {
  PlatformAccessory,
  hap,
  makeScheduleAccount,
  makeSchedulePlatform,
  switchSubtypes,
} = require("../test-support/schedule-account");
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;
const RoborockPlatform = require("../src/platform").default;

const DUID = "duid-s8";

/** The schedule accessory as Homebridge restores it after a restart. */
function restoredScheduleAccessory(...timerIds) {
  const accessory = new PlatformAccessory(
    "Rocky Schedules",
    hap.uuid.generate(`hap:roborock:schedules:${DUID}`)
  );
  accessory.context = {
    kind: "hapExtension",
    extension: "schedules",
    duid: DUID,
  };
  timerIds.forEach((id, index) => {
    accessory
      .addService(
        hap.Service.Switch,
        `Rocky Schedule ${index + 1}`,
        `roborock-schedule-${id}`
      )
      .getCharacteristic(hap.Characteristic.On)
      .updateValue(true);
  });
  return accessory;
}

test("a switch restored from the cache for a schedule the account no longer has is removed", async () => {
  const account = makeScheduleAccount({
    duid: DUID,
    serverTimers: [["200", "on", ["0 9 * * 1", ["start_clean", 106]]]],
  });
  const platform = makeSchedulePlatform(account);
  const accessory = restoredScheduleAccessory("123", "200");

  const coordinator = new RoborockHapScheduleAccessory(
    platform,
    accessory,
    DUID
  );
  const result = await coordinator.initialize("Rocky");

  expect(result).toEqual({ success: true, hasSchedules: true });
  expect(switchSubtypes(accessory)).toEqual(["roborock-schedule-200"]);
  const on = accessory
    .getServiceById(hap.Service.Switch, "roborock-schedule-200")
    .getCharacteristic(hap.Characteristic.On);
  expect(typeof on.setHandler).toBe("function");
  expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([
    accessory,
  ]);
  coordinator.shutdown();
});

test("with no schedule left, the schedule accessory leaves Apple Home", async () => {
  const account = makeScheduleAccount({ duid: DUID, serverTimers: [] });
  const accessory = restoredScheduleAccessory("123");

  const platform = Object.create(RoborockPlatform.prototype);
  Object.assign(platform, makeSchedulePlatform(account), {
    platformConfig: {
      enableHomeKitActionSwitches: true,
      enableHomeKitScheduleSwitches: true,
    },
    accessories: [accessory],
    hapScheduleAccessories: new Map(),
    scheduleAccountCoordinator: undefined,
    schedulePolicyLogged: true,
  });
  platform.api = {
    ...platform.api,
    platformAccessory: PlatformAccessory,
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
  };
  platform.getVacuumDisplayName = () => "Rocky";

  platform.syncHapSchedules([{ duid: DUID }]);
  await new Promise((resolve) => setImmediate(resolve));

  expect(switchSubtypes(accessory)).toEqual([]);
  expect(platform.api.unregisterPlatformAccessories).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    [accessory]
  );
  expect(platform.accessories).not.toContain(accessory);
  for (const schedule of platform.hapScheduleAccessories.values()) {
    schedule.shutdown();
  }
});
