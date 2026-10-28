"use strict";

/**
 * #26: a second "refill the water tank" for one empty tank, after a spell
 * without a live status.
 *
 * Live values older than 15 minutes used to fall back to the cloud's HomeData
 * snapshot for EVERY field. HomeData is keyed by schema id and carries no tank
 * field at all, so the tank verdict became unknown while `error_code` read the
 * snapshot's 0 — "affirmatively fine". The standing fault was withdrawn, and
 * the next reply with the tank still empty raised it again: matter.js emits
 * the OperationalError event on every raise, so that is a second notification.
 * A docked robot at 100 % sends no battery pushes, and the get_status timeouts
 * of #24/#27 are exactly such a spell.
 *
 * Staleness may only hand a field to HomeData when HomeData has the field.
 * Otherwise the last thing the robot said is still the only evidence there is.
 *
 * Real Roborock API with the a144's own HomeData snapshot (#22), the robot's
 * own docked reply with an empty clean tank, the real 60-second heartbeat, and
 * test-support/matter-0.17.9-store.js for what matter.js does with the writes.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const { CAPTURES } = require("../test-support/a144-vacuum-harness");

const WATER_TANK_EMPTY = 68;
// Keep the captured dock fault; add an onboard shortage so BOTH water
// supplies are empty under the Matter blocking policy. The original capture
// has shortage 0 and still drives the independent HAP sensor tests.
const DOCKED_TANK_EMPTY = {
  ...CAPTURES.run1_1748_dockedBothTanksFlagged.reply[0],
  water_shortage_status: 1,
};

afterEach(() => {
  disposeRealApiVacuums();
  jest.useRealTimers();
});

async function dockedA144WithEmptyTank() {
  jest.useFakeTimers({
    now: Date.UTC(2026, 9, 18, 22, 0, 0),
    doNotFake: ["nextTick", "setImmediate"],
  });
  const robot = await createRealApiVacuum({
    model: "roborock.vacuum.a144",
    // The a144's HomeData snapshot from #22 (test-support/a144-vacuum-harness).
    homeData: {
      error_code: 0,
      state: 8,
      battery: 100,
      fan_power: 110,
      water_box_mode: 209,
      charge_status: 1,
    },
  });
  await robot.localReply(DOCKED_TANK_EMPTY);
  return robot;
}

const fault = (robot) =>
  robot.store.read("rvcOperationalState", "operationalError").errorStateId;

describe("a standing tank fault survives a spell without live status", () => {
  test("sixteen minutes of heartbeats without a reply keep the fault standing", async () => {
    const robot = await dockedA144WithEmptyTank();
    expect(fault(robot)).toBe(WATER_TANK_EMPTY);
    expect(robot.store.events).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(16 * 60 * 1000);

    expect(fault(robot)).toBe(WATER_TANK_EMPTY);
    expect(robot.store.events).toHaveLength(1);
  });

  test("the reply after the outage, tank still empty, is not a second notification", async () => {
    const robot = await dockedA144WithEmptyTank();

    await jest.advanceTimersByTimeAsync(16 * 60 * 1000);
    await robot.localReply(DOCKED_TANK_EMPTY);

    expect(fault(robot)).toBe(WATER_TANK_EMPTY);
    expect(robot.store.events).toHaveLength(1);
  });

  test("fields HomeData does carry still self-heal from it once the live value is stale", async () => {
    const robot = await dockedA144WithEmptyTank();
    expect(robot.vacuum.getNumberStatus("battery")).toBe(88);

    await jest.advanceTimersByTimeAsync(16 * 60 * 1000);

    // The cloud snapshot's battery wins over a 16-minute-old live reading...
    expect(robot.vacuum.getNumberStatus("battery")).toBe(100);
    // ...and a field the snapshot does not have keeps the robot's last word.
    expect(robot.vacuum.getNumberStatus("dock_error_status")).toBe(39);
    expect(robot.vacuum.getNumberStatus("in_cleaning")).toBe(0);
  });
});
