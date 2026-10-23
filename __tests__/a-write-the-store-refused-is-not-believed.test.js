"use strict";

/**
 * Homebridge 2.4.0 never tells a plugin that matter.js refused a write: its
 * `api.matter.updateAccessoryState` emits and returns, the store write runs
 * later in a setImmediate, and a refusal is only logged (MatterAPIImpl.js,
 * StateManager.js). The plugin used to record each write as published the
 * moment the call returned and skip any identical snapshot after that, so a
 * refused write stayed believed until the heartbeat forced a rewrite — one
 * minute for most clusters, ten for the operational state.
 *
 * Homebridge does let a plugin read the store back
 * (`api.matter.getAccessoryState`, which for an external accessory reads the
 * endpoint's own state). Publishing against that, the next ordinary publish
 * repairs a refused write.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const { createMatterStore } = require("../test-support/matter-0.17.9-store");

afterEach(disposeRealApiVacuums);

const RUNNING = 1;
const CHARGING = 65;

const DOCKED = {
  state: 8,
  battery: 90,
  charge_status: 1,
  error_code: 0,
  in_cleaning: 0,
  fan_power: 102,
  water_box_mode: 201,
};
const CLEANING = {
  ...DOCKED,
  state: 5,
  battery: 89,
  charge_status: 0,
  in_cleaning: 1,
};

/** A matter API that refuses the next write carrying `attribute`. */
function refusingOnce(store, attribute) {
  let refuse = true;
  return {
    updateAccessoryState: async (uuid, cluster, attributes) => {
      if (refuse && attribute in attributes) {
        refuse = false;
        return;
      }
      await store.updateAccessoryState(uuid, cluster, attributes);
    },
    getAccessoryState: (uuid, cluster) =>
      store.getAccessoryState(uuid, cluster),
  };
}

describe("a write the Matter store refused is not believed", () => {
  test("the next status reply writes the operational state again, without waiting for a heartbeat", async () => {
    const robot = await createRealApiVacuum({
      platformConfig: { enableMatterChargingDockedStates: true },
    });
    await robot.localReply(DOCKED);
    expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
      CHARGING
    );

    const matter = refusingOnce(robot.store, "operationalState");
    robot.vacuum["platform"].getMatterApi = () => matter;

    await robot.localReply(CLEANING);
    expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
      CHARGING
    );

    // 15 seconds later the poll answers the same: still cleaning.
    await robot.localReply(CLEANING);
    expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
      RUNNING
    );
  });

  test("the once-per-boot battery nudge lands as null and then the value, even when Homebridge applies writes later", async () => {
    // The cloud snapshot already says 90 %, so the endpoint registers with
    // the very value the robot then reports: only the nudge changes it.
    const robot = await createRealApiVacuum({
      homeData: {
        error_code: 0,
        state: 8,
        battery: 90,
        fan_power: 102,
        water_box_mode: 201,
        charge_status: 1,
      },
    });
    // Homebridge applies each write in a setImmediate.
    const store = createMatterStore(robot.accessory.clusters, {
      deferWrites: true,
    });
    robot.vacuum["platform"].getMatterApi = () => store;

    await robot.localReply(DOCKED);
    await robot.settle();

    const written = store.writes
      .filter(
        (write) =>
          write.cluster === "powerSource" &&
          "batPercentRemaining" in write.attributes
      )
      .map((write) => write.attributes.batPercentRemaining);
    expect(written).toEqual([null, 180]);
    expect(store.read("powerSource", "batPercentRemaining")).toBe(180);
  });
});
