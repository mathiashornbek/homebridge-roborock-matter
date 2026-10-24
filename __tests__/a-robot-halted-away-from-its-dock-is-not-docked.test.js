"use strict";

/**
 * A robot that has stopped somewhere on the floor is not in its dock (#28).
 *
 * CooperCGN sent his S8 Pro Ultra to a spot with "pin & go" in the Roborock
 * app. The Docked sensor opened when it left, and closed again the moment it
 * stopped at the spot — 5 m from the dock.
 *
 * The plugin treated a non-zero `charge_status` as proof of the dock for every
 * state it did not list as "out cleaning", and Idle (3) is not on that list.
 * But `charge_status` does not say where the robot is. Roborock robots report
 * 1 off the dock: the a144 in test-support/issue-22-a144-captures.json says
 * `state: 18, charge_status: 1` in one and the same get_status reply, in the
 * middle of a room clean. python-roborock reads it the same way: its
 * get_dock_state() places the robot from `state` alone (8 and 100 on the dock;
 * returning, docking and everything else away) and reads `charge_status` only
 * to tell off-peak waiting from charging while the state already says 8.
 *
 * The frames below are the a144's real mid-run reply with the state moved
 * (and the tank fields of its startup reply), so `charge_status` is the value
 * a robot really reports off the dock.
 */

const CAPTURES = require("../test-support/issue-22-a144-captures.json");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const MID_RUN_REPLY = CAPTURES.run1_1731_dirtyFullMasksCleanEmpty.reply[0];
const DOCKED_REPLY = CAPTURES.run1_1713_startupAllOk.reply[0];

const STOPPED = 0;
const DOCKED = 66;

function createVacuum({ chargingDocked = true } = {}) {
  const status = {};
  const published = { rvcOperationalState: {} };
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableMatterExtendedOperationalStates: true,
      enableMatterChargingDockedStates: chargingDocked,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn(async (_uuid, cluster, attributes) => {
        if (attributes && cluster in published) {
          Object.assign(published[cluster], attributes);
        }
      }),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Vicky" : "sn-1",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
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
  const accessory = { UUID: "uuid-vacuum", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );

  return {
    /** A full get_status reply. */
    async reply(frame) {
      Object.assign(status, frame);
      await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
    },
    /** A pushed datapoint frame: only the fields it names move. */
    async push(dps) {
      await vacuum.notifyDeviceUpdater("CloudMessage", { dps });
    },
    docked: () => vacuum.getHomeKitStateSensorValue("docked"),
    publishedOperationalState: () =>
      published.rvcOperationalState.operationalState,
  };
}

// The tanks as they were at startup: the mid-run reply also reports a full
// dirty-water tank, and a fault is not what these tests are about.
const awayFromTheDock = (state) => ({
  ...MID_RUN_REPLY,
  state,
  in_cleaning: 0,
  dock_error_status: DOCKED_REPLY.dock_error_status,
  dss: DOCKED_REPLY.dss,
});

test("the captured reply really says charge_status 1 away from the dock", () => {
  // The premise, pinned: if the capture ever changes, this test says so
  // before the ones below pass for the wrong reason.
  expect(MID_RUN_REPLY.state).toBe(18);
  expect(MID_RUN_REPLY.charge_status).toBe(1);
});

test("pin & go: the sensor stays Open when the robot stops at the spot", async () => {
  const vacuum = createVacuum();
  await vacuum.reply(DOCKED_REPLY);
  expect(vacuum.docked()).toBe(true);

  // It leaves for the spot: the state moves on its own, charge_status does not.
  await vacuum.push({ 121: 16 });
  expect(vacuum.docked()).toBe(false);

  // It stops there.
  await vacuum.push({ 121: 3 });
  expect(vacuum.docked()).toBe(false);

  // The next status reply says Idle, with charge_status 1 as robots report it.
  await vacuum.reply(awayFromTheDock(3));
  expect(vacuum.docked()).toBe(false);

  // Back on the dock.
  await vacuum.reply(DOCKED_REPLY);
  expect(vacuum.docked()).toBe(true);
});

test.each([
  ["charger disconnected", 2],
  ["idle", 3],
  ["returning to the dock", 6],
  ["docking", 15],
  ["going to wash the mop", 26],
])("a robot %s with charge_status 1 is not docked", async (_label, state) => {
  const vacuum = createVacuum();
  await vacuum.reply(awayFromTheDock(state));

  expect(vacuum.docked()).toBe(false);
});

test("the tile does not say Docked or Charging for a robot standing idle on the floor", async () => {
  const vacuum = createVacuum({ chargingDocked: true });
  // Fully charged on the dock (battery 100).
  await vacuum.reply(DOCKED_REPLY);
  expect(vacuum.publishedOperationalState()).toBe(DOCKED);

  await vacuum.reply(awayFromTheDock(3));
  expect(vacuum.publishedOperationalState()).toBe(STOPPED);
});

test.each([
  ["charging", 8],
  ["fully charged", 100],
  ["emptying the bin", 22],
  ["washing the mop", 23],
])("a robot %s in its dock still reads docked", async (_label, state) => {
  const vacuum = createVacuum();
  await vacuum.reply({ ...DOCKED_REPLY, state });

  expect(vacuum.docked()).toBe(true);
});
