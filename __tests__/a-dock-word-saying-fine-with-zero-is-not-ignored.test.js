"use strict";

/**
 * The dock's status word `dss` carries each tank in two bits. python-roborock
 * reads a 0 in the clean- or dirty-water field of a wash dock as "okay"
 * (`ClearWaterBoxStatus.okay`, `DirtyWaterBoxStatus.okay`); only the
 * cleaning-fluid field treats 0 as "not supported". The plugin read 0 as "not
 * said" for all three, so on a dock that says "fine" with a 0, a lingering
 * `water_shortage_status: 1` decided the clean tank was empty — the shape of
 * #26's "still empty after refilling".
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

// A wash dock (dock_type 15, the #26 reporter's) whose word is non-zero —
// dust bag field 2 — with both water fields 0: python-roborock "okay".
const DSS_WATER_FIELDS_ZERO = 2 << 6;

const DOCKED = {
  state: 8,
  battery: 100,
  charge_status: 1,
  error_code: 0,
  in_cleaning: 0,
  dock_type: 15,
  dock_error_status: 0,
  water_shortage_status: 1,
  dss: DSS_WATER_FIELDS_ZERO,
};

test("a clean-water field of 0 is the dock saying the tank is fine", async () => {
  const robot = await createRealApiVacuum({ model: "roborock.vacuum.a104" });

  await robot.localReply(DOCKED);

  expect(robot.vacuum.getHomeKitStateSensorValue("waterTankEmpty")).toBe(false);
  expect(robot.vacuum.getHomeKitStateSensorValue("dirtyWaterTankFull")).toBe(
    false
  );
  expect(
    robot.store.read("rvcOperationalState", "operationalError").errorStateId
  ).toBe(0);
  expect(robot.store.events).toEqual([]);
});

test("a cleaning-fluid field of 0 is still a dock without one", async () => {
  const robot = await createRealApiVacuum({ model: "roborock.vacuum.a104" });

  await robot.localReply(DOCKED);

  expect(robot.vacuum.getHomeKitStateSensorValue("cleaningFluidEmpty")).toBe(
    null
  );
});
