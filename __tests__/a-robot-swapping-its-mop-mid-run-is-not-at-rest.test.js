"use strict";

/**
 * The fault gate (canCarryAFault) judges the
 * robot's own state through getRoborockOperationalState(), which sends every
 * state it does not name to Stopped/Charging. DSimeone1989's a144 (#22)
 * reports state 33 ("attaching the mop", python-roborock RoborockStateCode)
 * with in_cleaning 3 — a room clean in progress — and charge_status 1, so the
 * gate reads a robot in the middle of a run as "at rest".
 *
 * Real frames only, from test-support/issue-22-a144-captures.json: the 18:20
 * mid-run reply (state 18, clean tank empty: dock_error_status 38, dss 2212)
 * and the 17:52 state-33 reply. The 33 frame carries the tank fields of the
 * reply before it (the tank does not refill itself between them). Replayed
 * through the faithful 0.17.9 store.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");
const CAPTURES = require("../test-support/issue-22-a144-captures.json");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const DUID = "device-a144";
const RUNNING = 1;
const ERROR = 3;

function a144WithStore() {
  let store;
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableMatterExtendedOperationalStates: true,
      enableMatterChargingDockedStates: true,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Rocky" : "",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: (duid, property) =>
        ({
          error_code: 0,
          state: 8,
          battery: 100,
          fan_power: 110,
          water_box_mode: 209,
          charge_status: 1,
        })[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: false,
        canControlWater: true,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
  const accessory = { UUID: "uuid-a144", context: { duid: DUID } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: DUID },
    true
  );
  store = createMatterStore(accessory.clusters);
  const send = (frame) =>
    vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: DUID,
      payload: [JSON.parse(JSON.stringify(frame))],
    });
  return { vacuum, store, send };
}

test("a144 docking mid-run to attach its mop (state 33, in_cleaning 3) is not published as Error", async () => {
  const { vacuum, store, send } = a144WithStore();
  const midRun = CAPTURES.run2_1820_cleanEmptyOnly.reply[0];
  const attaching = {
    ...CAPTURES.run2_1752_afterRefill.reply[0],
    dock_error_status: midRun.dock_error_status,
    dss: midRun.dss,
  };
  expect(attaching).toMatchObject({ state: 33, in_cleaning: 3 });

  await send(midRun);
  expect(store.read("rvcOperationalState", "operationalState")).toBe(RUNNING);
  expect(store.events).toEqual([]);

  // To the dock for the mop, and straight back out to the next room.
  const states = [];
  await send(attaching);
  states.push(store.read("rvcOperationalState", "operationalState"));
  await send(midRun);
  await send(attaching);
  states.push(store.read("rvcOperationalState", "operationalState"));
  await send(midRun);
  vacuum.dispose();

  // The run never stopped, so the tile never says it did, and nobody is
  // notified twice about one empty tank mid-run.
  expect(states).not.toContain(ERROR);
  expect(store.events).toEqual([]);
});
