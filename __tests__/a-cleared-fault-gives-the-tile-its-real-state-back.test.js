"use strict";

/**
 * When a fault clears, matter.js 0.17.9 does NOT give the operational state
 * back. RvcOperationalStateServer.ts:87-90 returns early for NoError; the
 * state it forced to Error at :92-94 stays Error until something writes a
 * different operationalState.
 *
 * writeOperationalStateCluster() writes operationalState only when it differs
 * from `publishedOperationalState` — the value the PLUGIN last wrote, not the
 * value the store holds. Raising a fault changes the store (-> 3) without
 * touching that bookkeeping, so after the fault clears the plugin believes
 * Docked is still published and writes only `operationalError: NoError`.
 * The controller is left reading Error-with-no-error until the robot changes
 * state or the 10th heartbeat re-asserts the state (~10 minutes).
 *
 * This is the docked half of #35: switch Home's mode from Vacuum + Mop to
 * Vacuum, or refill the tank, and the fault clears but the tile does not get
 * Docked back.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const DOCKED = 66;
const ERROR = 3;
const NO_ERROR = 0;
const WATER_TANK_EMPTY = 68;

function harness(status) {
  let store;
  const platform = {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    platformConfig: { enableMatter: true },
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Downtown Rock" : "",
      getProductAttribute: () => "roborock.vacuum.a27",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
  const accessory = { UUID: "uuid-35b", context: { duid: "device-35b" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-35b" },
    true
  );
  store = createMatterStore(accessory.clusters);
  return { vacuum, store };
}

const DOCKED_FULL = { state: 8, battery: 100, charge_status: 1, error_code: 0 };

describe("a cleared fault gives the tile its real state back", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("refilling the tank of a docked robot returns the tile to Docked", async () => {
    const status = { ...DOCKED_FULL, dock_error_status: 0 };
    const { vacuum, store } = harness(status);
    await vacuum.updateMatterStateFromRoborock();

    status.dock_error_status = 38; // the tank runs dry while docked
    await vacuum.updateMatterStateFromRoborock();
    // The 0.17.9 store, faithfully: the fault dragged the state to Error.
    expect(store.read("rvcOperationalState", "operationalError")).toEqual({
      errorStateId: WATER_TANK_EMPTY,
    });
    expect(store.read("rvcOperationalState", "operationalState")).toBe(ERROR);

    status.dock_error_status = 0; // tank refilled
    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    expect(store.read("rvcOperationalState", "operationalError")).toEqual({
      errorStateId: NO_ERROR,
    });
    // Fails on 3.34.0: only `operationalError: NoError` is written, and the
    // store keeps operationalState=3.
    expect(store.read("rvcOperationalState", "operationalState")).toBe(DOCKED);
  });

  test("choosing Vacuum in Apple Home (the #35 afternoon test) returns the tile to Docked", async () => {
    const status = { ...DOCKED_FULL, dock_error_status: 0 };
    const { vacuum, store } = harness(status);
    await vacuum.updateMatterStateFromRoborock();
    status.dock_error_status = 38;
    await vacuum.updateMatterStateFromRoborock();
    expect(store.read("rvcOperationalState", "operationalState")).toBe(ERROR);

    await vacuum.changeCleanMode(0); // Vacuum: the tank no longer blocks
    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    expect(store.read("rvcCleanMode", "currentMode")).toBe(0);
    expect(store.read("rvcOperationalState", "operationalError")).toEqual({
      errorStateId: NO_ERROR,
    });
    expect(store.read("rvcOperationalState", "operationalState")).toBe(DOCKED);
  });

  test("a standing fault raises the OperationalError event once, not every 10th heartbeat", async () => {
    const status = { ...DOCKED_FULL, dock_error_status: 0 };
    const { vacuum, store } = harness(status);
    await vacuum.updateMatterStateFromRoborock();
    status.dock_error_status = 38;
    await vacuum.updateMatterStateFromRoborock();
    expect(store.events).toEqual([{ errorStateId: WATER_TANK_EMPTY }]);

    // Half an hour of heartbeats with nothing changing on the robot.
    for (let i = 0; i < 30; i += 1) {
      await vacuum.publishCurrentMatterState("Matter state heartbeat");
    }
    vacuum.dispose();

    // Fails on 3.34.0: every RESYNC_OPERATIONAL_STATE_EVERY_FORCED_WRITES
    // heartbeats the plugin re-writes operationalState, which (store in
    // Error, error standing) clears the error (RvcOperationalStateServer.ts:
    // 78-84); the plugin then re-asserts 68 and matter.js emits the event
    // again (:96). One event per ~10 minutes for as long as the tank is empty.
    expect(store.events).toHaveLength(1);
  });
});
