"use strict";

/**
 * #26, the repeat that was left: a standing tank fault was withdrawn whenever
 * the robot passed through a state that "cannot carry a fault", and raised
 * again when it was back at rest. matter.js 0.17.9 emits the OperationalError
 * event on every raise, so each pass was one more "refill the water tank".
 *
 * The rule those states served is right for a robot that is CLEANING: any
 * fault forces the Matter state to Error, and a running robot shown as Error
 * hides the clean (#35). It is wrong for a robot sitting idle in its dock,
 * where the dock empties the bin (22), washes or dries the mop (23, 25),
 * swaps the mop (33/34) or reports the one-second "returning" blip after
 * emptying (6). Nothing about the tank changed and no run started; the fault
 * keeps standing, and the phase says what the dock is doing.
 *
 * A run is different on purpose, and pinned here as such: a robot that
 * actually cleans has its fault withdrawn while it works (#35), and gets it
 * back — one notification — when it is home with the tank still empty.
 *
 * Real Roborock API, the a144's own docked reply with an empty clean tank
 * (#22), matter.js 0.17.9 replay.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const { CAPTURES } = require("../test-support/a144-vacuum-harness");
const { createMatterStore } = require("../test-support/matter-0.17.9-store");

afterEach(disposeRealApiVacuums);

const ERROR = 3;
const RUNNING = 1;
const WATER_TANK_EMPTY = 68;
const NO_ERROR = 0;

const DOCKED_TANK_EMPTY = CAPTURES.run1_1748_dockedBothTanksFlagged.reply[0];
const at = (state, extra = {}) => ({ ...DOCKED_TANK_EMPTY, state, ...extra });

async function dockedWithEmptyTank() {
  const robot = await createRealApiVacuum({ model: "roborock.vacuum.a144" });
  await robot.localReply(DOCKED_TANK_EMPTY);
  expect(robot.store.events).toHaveLength(1);
  return robot;
}

const fault = (store) =>
  store.read("rvcOperationalState", "operationalError").errorStateId;

describe("housekeeping at an idle dock does not repeat a tank warning", () => {
  test.each([
    ["emptying the dust bin", [at(22), at(8)]],
    ["washing the mop", [at(23), at(8)]],
    ["washing the mop (25)", [at(25), at(8)]],
    ["mapping", [at(29), at(8)]],
    ["swapping the mop", [at(34), at(8)]],
    ["the returning blip after emptying", [at(22), at(6), at(8)]],
  ])("%s", async (_label, frames) => {
    const robot = await dockedWithEmptyTank();

    for (const frame of frames) {
      await robot.localReply(frame);
      // Standing throughout: the store never leaves the fault.
      expect(fault(robot.store)).toBe(WATER_TANK_EMPTY);
      expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
        ERROR
      );
    }

    expect(robot.store.events).toHaveLength(1);
  });

  test("the dock's job is still said, as the phase", async () => {
    const robot = await dockedWithEmptyTank();

    await robot.localReply(at(22));

    expect(robot.store.read("rvcOperationalState", "currentPhase")).toBe(0);
    expect(robot.store.read("rvcOperationalState", "phaseList")[0]).toBe(
      "Emptying dust bin"
    );
  });

  test("a chore reported in the same instant as the raise does not wipe it, even though Homebridge applies writes later", async () => {
    const robot = await createRealApiVacuum({ model: "roborock.vacuum.a144" });
    const store = createMatterStore(robot.accessory.clusters, {
      deferWrites: true,
    });
    robot.vacuum["platform"].getMatterApi = () => store;

    await Promise.all([
      robot.localReply(DOCKED_TANK_EMPTY),
      robot.localReply(at(22)),
    ]);
    await robot.settle();
    await robot.localReply(DOCKED_TANK_EMPTY);
    await robot.settle();

    expect(fault(store)).toBe(WATER_TANK_EMPTY);
    expect(store.events).toHaveLength(1);
  });

  test("a real run withdraws the fault while the robot cleans and raises it once when it is home", async () => {
    const robot = await dockedWithEmptyTank();

    await robot.localReply(at(5, { charge_status: 0, in_cleaning: 1 }));
    expect(fault(robot.store)).toBe(NO_ERROR);
    expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
      RUNNING
    );

    await robot.localReply(at(6, { charge_status: 0, in_cleaning: 1 }));
    expect(fault(robot.store)).toBe(NO_ERROR);

    await robot.localReply(at(8, { in_cleaning: 0 }));
    expect(fault(robot.store)).toBe(WATER_TANK_EMPTY);
    expect(robot.store.events).toHaveLength(2);
  });
});
