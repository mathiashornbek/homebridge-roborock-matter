"use strict";

// Two quick toggles of one schedule switch, driven through real hap-nodejs:
// OFF, which Roborock accepts but does not keep, and ON a second later, which
// fails after Home has had its answer. Each failure used to turn the switch
// back to the value it showed when that toggle started — for the second
// toggle, the first one's optimistic OFF — so the switch ended OFF while
// Roborock held ON, until the next schedule refresh. A late failure now puts
// the switch back to what Roborock last reported.

const {
  PlatformAccessory,
  hap,
  makeScheduleAccount,
  makeSchedulePlatform,
  scene,
} = require("../test-support/schedule-account");
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

const DUID = "duid-a144";
const coordinators = [];
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.shutdown();
  jest.useRealTimers();
});

async function setup() {
  const account = makeScheduleAccount({
    duid: DUID,
    scenes: [scene({ id: 1, name: "Mornings", duid: DUID })],
    serverTimers: new Error(
      "The robot refused get_server_timer: Not FCC robot (code -10007)."
    ),
  });
  const platform = makeSchedulePlatform(account);
  const manager = new PlatformAccessory(
    "Rocky Schedules",
    hap.uuid.generate("schedules")
  );
  const coordinator = new RoborockHapScheduleAccessory(platform, manager, DUID);
  coordinators.push(coordinator);
  await coordinator.initialize("Rocky");
  const on = manager
    .getServiceById(hap.Service.Switch, "roborock-schedule-scene%3A1")
    .getCharacteristic(hap.Characteristic.On);
  return { account, platform, on };
}

/** Whether Roborock holds the schedule enabled, read from its own record. */
const roborockHolds = (account) =>
  JSON.parse(JSON.parse(account.state.scenes[0].param).triggers[0].param)
    .enabled;

test("off (accepted, not kept) then on (fails late) ends showing what Roborock holds", async () => {
  const { account, on, platform } = await setup();
  expect(on.value).toBe(true);
  let call = 0;
  account.updateCloudSceneParam.mockImplementation(async () => {
    call += 1;
    if (call === 1) return undefined; // accepted, not kept
    await new Promise((resolve) => setTimeout(resolve, 4000));
    throw new Error("network down");
  });

  const first = on.handleSetRequest(false).catch(() => undefined);
  await jest.advanceTimersByTimeAsync(1000);
  const second = on.handleSetRequest(true).catch(() => undefined);
  await jest.advanceTimersByTimeAsync(40_000);
  await Promise.all([first, second]);

  expect(roborockHolds(account)).toBe(true);
  expect(on.value).toBe(true);
  const warnings = platform.log.warn.mock.calls.map(([line]) => String(line));
  expect(
    warnings.filter((line) => /shows the schedule as off/.test(line))
  ).toEqual([]);
});
