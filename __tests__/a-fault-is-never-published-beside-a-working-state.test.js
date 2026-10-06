"use strict";

/**
 * The fault gate (OPERATIONAL_STATES_THAT_CARRY_A_FAULT), as found in review of 3.35.0.
 *
 * The gate decides whether a fault may be published from the robot's REAL
 * operational state, but what reaches matter.js is the cluster after the
 * optimistic merge and after the controller mapping. Whenever those differ
 * the store can still be told "Running (or SeekingCharger) + fault", which
 * matter.js 0.17.9 turns into Error — the #35 symptom the gate exists for.
 *
 * Replayed through the faithful 0.17.9 store model.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RUNNING = 1;
const ERROR = 3;

function harness(status, config = {}) {
  let store;
  const api = {
    getVacuumDeviceInfo: (duid, property) =>
      property === "name" ? "Review Rock" : "",
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
    app_start: jest.fn().mockResolvedValue(undefined),
    applyMatterCleanModeSettings: jest.fn().mockResolvedValue(undefined),
  };
  const platform = {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    platformConfig: { enableMatter: true, ...config },
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: api,
  };
  const accessory = { UUID: "uuid-review", context: { duid: "device-review" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-review" },
    true
  );
  store = createMatterStore(accessory.clusters);
  return { vacuum, store, platform };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the fault gate is applied before the optimistic merge", () => {
  test("Start pressed in Apple Home, dock reports the tank dry before the robot reports Cleaning", async () => {
    // Docked, charging, tank fine. Vacuum + Mop on the robot.
    const status = {
      state: 8,
      battery: 90,
      charge_status: 1,
      error_code: 0,
      dock_error_status: 0,
      water_box_custom_mode: 202,
    };
    const { vacuum, store, platform } = harness(status);
    await vacuum.updateMatterStateFromRoborock();
    expect(store.read("rvcOperationalState", "operationalState")).toBe(65);

    // Play pressed on the tile: optimistic Running is published.
    await vacuum.changeRunMode(1);
    await tick();
    expect(store.read("rvcOperationalState", "operationalState")).toBe(RUNNING);

    // The dock tries to wet the mop and finds no water (38). A cloud-only
    // robot is still reporting 8 at this point (the lag the optimistic
    // window exists for, issue #4).
    status.dock_error_status = 38;
    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    // The store answers Error, with a fresh "Refill the water tank" event…
    expect(store.read("rvcOperationalState", "operationalState")).toBe(RUNNING);
    expect(store.events).toEqual([]);
    // …while the plugin's own evidence line reads exactly what #35 decoded.
    const line = platform.log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("Matter publish for"))
      .pop();
    expect(line).not.toMatch(/operationalState=1,.*fault=68 \(/);
  });
});

describe("the gate reads the controller-mapped state, not the robot's", () => {
  test("Extended Operational States off: a robot driving home with no water is published as Error", async () => {
    const status = {
      state: 5,
      battery: 80,
      charge_status: 0,
      error_code: 0,
      dock_error_status: 0,
      water_box_custom_mode: 202,
    };
    const { vacuum, store } = harness(status, {
      enableMatterExtendedOperationalStates: false,
    });
    await vacuum.updateMatterStateFromRoborock();
    expect(store.read("rvcOperationalState", "operationalState")).toBe(RUNNING);

    // The tank runs dry and the robot heads home (state 6) to refill.
    Object.assign(status, { state: 6, battery: 60, dock_error_status: 38 });
    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    // Not blocked — it is driving — yet the store reads Error and fired the
    // OperationalError event, because SeekingCharger is mapped to Stopped
    // before the gate looks at it.
    expect(store.read("rvcOperationalState", "operationalState")).not.toBe(
      ERROR
    );
    expect(store.events).toEqual([]);
  });
});
