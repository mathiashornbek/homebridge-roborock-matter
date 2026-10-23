"use strict";

// A schedule switch's HomeKit write used to await everything: the 500 ms
// batch window, the cloud write, a fixed 3 s wait, a verification reading of
// both sources (each up to 10 s), and possibly a fallback write with another
// wait and reading. hap-nodejs logs "slow to respond" after 3 s
// (Accessory.TIMEOUT_WARNING) and answers the controller OPERATION_TIMED_OUT
// after 9 s — so every toggle printed "This plugin slows down Homebridge", and
// on a robot with slow cloud replies (#24) a toggle that worked was reported
// to Home as failed and then flipped to the requested state seconds later.
//
// The write now answers within its budget: as soon as Roborock has accepted
// the write, or at 2.5 s, whichever is first. A failure known by then is
// still thrown (the switch never shows the refused state); a write that
// verification later fails to confirm is turned back, with the reason in the
// log.

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
const HAP_SLOW_WARNING_MS = hap.Accessory.TIMEOUT_WARNING;

const coordinators = [];

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.shutdown();
  }
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

/** Advance in small steps until the HomeKit write is answered. */
async function answeredAfter(request) {
  let answer;
  request.then(
    () => (answer = "resolved"),
    (status) => (answer = status)
  );
  let elapsed = 0;
  while (answer === undefined && elapsed < 20_000) {
    await jest.advanceTimersByTimeAsync(100);
    elapsed += 100;
  }
  return { answer, elapsed };
}

test("an accepted write is answered before HAP calls the plugin slow, and stays", async () => {
  const { on, platform } = await setup();
  expect(on.value).toBe(true);

  const { answer, elapsed } = await answeredAfter(on.handleSetRequest(false));

  expect(answer).toBe("resolved");
  expect(elapsed).toBeLessThan(HAP_SLOW_WARNING_MS);

  // Verification completes in the background and agrees.
  await jest.advanceTimersByTimeAsync(15_000);
  expect(on.value).toBe(false);
  expect(platform.log.warn).not.toHaveBeenCalled();
});

test("a slow cloud write is still answered within the budget", async () => {
  const { account, on } = await setup();
  const write = account.updateCloudSceneParam.getMockImplementation();
  account.updateCloudSceneParam.mockImplementation(
    (...args) =>
      new Promise((resolve) => setTimeout(() => resolve(write(...args)), 6000))
  );

  const { answer, elapsed } = await answeredAfter(on.handleSetRequest(false));

  expect(answer).toBe("resolved");
  expect(elapsed).toBeLessThan(HAP_SLOW_WARNING_MS);
  await jest.advanceTimersByTimeAsync(20_000);
  expect(on.value).toBe(false);
});

test("a write that Roborock accepts but does not keep is turned back, with the reason", async () => {
  const { account, on, platform } = await setup();
  // The cloud answers success and keeps the old param.
  account.updateCloudSceneParam.mockImplementation(async () => undefined);
  const changes = [];
  on.on("change", (change) => changes.push(change.newValue));

  const { answer, elapsed } = await answeredAfter(on.handleSetRequest(false));
  expect(answer).toBe("resolved");
  expect(elapsed).toBeLessThan(HAP_SLOW_WARNING_MS);

  await jest.advanceTimersByTimeAsync(15_000);

  expect(on.value).toBe(true);
  expect(changes.at(-1)).toBe(true);
  expect(platform.log.warn.mock.calls.join("\n")).toMatch(
    /did not confirm routine 1 as disabled/
  );
});
