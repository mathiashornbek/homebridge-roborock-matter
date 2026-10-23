"use strict";

/**
 * Identify ("Locate" / play a sound) published the tile with the optimistic
 * overlay cleared. Pressed in the minute after Start — while a cloud-only
 * robot still reports docked (#4) — it snapped the tile back to Docked until
 * the robot reported Cleaning. Locating a robot says nothing about whether it
 * is starting.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

const RUNNING = 1;
const DOCKED = { state: 8, battery: 100, charge_status: 1, error_code: 0 };

test("identify right after Start keeps the tile on the start", async () => {
  const robot = await createRealApiVacuum();
  await robot.localReply(DOCKED);
  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await robot.settle();
  expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
    RUNNING
  );

  await robot.accessory.handlers.identify.identify();
  await robot.settle();

  expect(robot.commands).toContain("find_me");
  expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
    RUNNING
  );
});
