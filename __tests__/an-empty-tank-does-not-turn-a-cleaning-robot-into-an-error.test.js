"use strict";

/**
 * Issue #35: an empty clean-water tank, a robot that keeps cleaning, and an
 * Apple Home tile that says "Refill the water tank" and nothing about the
 * clean. The plugin logs `operationalState=1 ... fault=68`; the decoded report
 * on the wire carries operationalState 3 (Error).
 *
 * That is not Apple and not the transport. It is @matter/node 0.17.9's
 * RvcOperationalStateServer (src/behaviors/rvc-operational-state/
 * RvcOperationalStateServer.ts:87-97): any operationalError other than
 * NoError sets operationalState to Error and emits the OperationalError event.
 * In 0.17.9 there is no such thing as "Running with a warning" — publishing a
 * fault IS publishing Error.
 *
 * The plugin believes otherwise (buildOperationalStateCluster: "The
 * operational state is deliberately NOT forced to Error along with it"), and
 * the tests that pinned that belief used a store model without the forcing
 * reactor. These tests replay the plugin's writes through a model of the real
 * store (test-support/matter-0.17.9-store.js) and ask what the controller
 * reads.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RUNNING = 1;
const SEEKING_CHARGER = 64;
const ERROR = 3;

function harness(status) {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  let store;
  const platform = {
    log,
    platformConfig: { enableMatter: true },
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Uptown Rock" : "",
      getProductAttribute: () => "roborock.vacuum.a27",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlWater: true,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
  const accessory = { UUID: "uuid-35", context: { duid: "device-35" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-35" },
    true
  );
  // Homebridge registers the endpoint with accessory.clusters as defaults.
  store = createMatterStore(accessory.clusters);
  return { vacuum, store };
}

describe("an empty tank does not turn a cleaning robot into an Error (#35)", () => {
  test("a robot cleaning in Vacuum + Mop with no water still reads Running", async () => {
    // Registered while docked and healthy, as on any ordinary morning.
    const status = { state: 8, battery: 100, charge_status: 1, error_code: 0 };
    const { vacuum, store } = harness(status);
    await vacuum.updateMatterStateFromRoborock();

    // 8:05 — the Roborock schedule starts a Vacuum + Mop run, tank empty.
    Object.assign(status, {
      state: 5, // cleaning (scheduled run, Dining room + Kitchen)
      battery: 82,
      charge_status: 0,
      dock_error_status: 38,
      water_shortage_status: 1,
      water_box_custom_mode: 202, // water on -> Vacuum + Mop
    });
    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    expect(store.rejected).toEqual([]);
    expect(store.read("rvcRunMode", "currentMode")).toBe(1);
    // Fails on 3.34.0: the plugin writes operationalState=1, then
    // operationalError=68, and the store answers operationalState=3.
    expect(store.read("rvcOperationalState", "operationalState")).toBe(RUNNING);
    expect(store.read("rvcOperationalState", "operationalState")).not.toBe(
      ERROR
    );
  });

  test("a robot driving home with no water reads SeekingCharger", async () => {
    const status = { state: 5, battery: 80, error_code: 0 };
    const { vacuum, store } = harness(status);
    await vacuum.updateMatterStateFromRoborock();

    Object.assign(status, {
      state: 6, // returning to dock
      battery: 70,
      dock_error_status: 38,
      water_shortage_status: 1,
      water_box_custom_mode: 202,
    });
    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    expect(store.read("rvcOperationalState", "operationalState")).toBe(
      SEEKING_CHARGER
    );
  });
});
