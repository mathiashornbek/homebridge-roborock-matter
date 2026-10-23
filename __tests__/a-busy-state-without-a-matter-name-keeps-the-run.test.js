"use strict";

/**
 * Roborock states the plugin had no arm for — 25 washing the mop, 33/34
 * attaching/detaching the mop, 6301-6310 the mopping states, 28/30/32 — fell
 * to the default arm and came out as Charging (charge_status set) or Stopped.
 * python-roborock names every one of them (`RoborockStateCode`).
 *
 * Mid-run that is three wrong things at once: Apple Home is told the robot
 * stopped (run mode Idle, "finished"), the requested rooms are marked
 * Completed, and when the robot reports Room Clean again the all-Completed
 * list is taken for a finished run and every room in the house is announced.
 * DSimeone's a144 does this on every mop swap (#22: state 33 with
 * `in_cleaning: 3` at the dock, in the middle of a room clean).
 *
 * The states that name an activity are mapped to it; the ones Matter has no
 * word for (28, 30, 32, 33, 34) keep the operational state the robot was last
 * in, the rule dock chores already follow for the run mode.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const { CAPTURES } = require("../test-support/a144-vacuum-harness");

afterEach(disposeRealApiVacuums);

const RUNNING = 1;
const SEEKING_CHARGER = 64;
const CHARGING = 65;
const CLEANING_MOP = 68;
const RUN_IDLE = 0;
const RUN_CLEANING = 1;

const OPERATING = 1;

// The a144's own replies (#22): a room clean at the dock, and the mop swap.
const ROOM_CLEAN = CAPTURES.run1_1731_dirtyFullMasksCleanEmpty.reply[0];
const MOP_SWAP = CAPTURES.run2_1752_afterRefill.reply[0];
const DOCKED = CAPTURES.run1_1713_startupAllOk.reply[0];

const clean = (overrides) => ({
  ...ROOM_CLEAN,
  dock_error_status: 0,
  dss: 2216,
  ...overrides,
});

async function robot(options = {}) {
  return createRealApiVacuum({ model: "roborock.vacuum.a144", ...options });
}

const tile = (r) => [
  r.store.read("rvcOperationalState", "operationalState"),
  r.store.read("rvcRunMode", "currentMode"),
];

describe("a busy state with no Matter name does not end the run", () => {
  test.each([
    ["25 washing the mop", { state: 25, charge_status: 1 }, CLEANING_MOP],
    ["6301 mopping", { state: 6301, charge_status: 0 }, RUNNING],
    ["6304 segment mopping", { state: 6304, charge_status: 0 }, RUNNING],
    ["6307 zoned mopping", { state: 6307, charge_status: 0 }, RUNNING],
    [
      "6310 back to the dock to wash the duster",
      { state: 6310, charge_status: 0 },
      SEEKING_CHARGER,
    ],
    ["33 attaching the mop", { state: 33, charge_status: 1 }, RUNNING],
    ["34 detaching the mop", { state: 34, charge_status: 1 }, RUNNING],
  ])("mid-run %s", async (_label, frame, expectedState) => {
    const r = await robot();
    await r.localReply(clean({ state: 18, charge_status: 0 }));
    expect(tile(r)).toEqual([RUNNING, RUN_CLEANING]);

    await r.localReply(clean(frame));

    expect(tile(r)).toEqual([expectedState, RUN_CLEANING]);
  });

  test("a mop swap at an idle dock is not a cleaning", async () => {
    const r = await robot({
      platformConfig: { enableMatterChargingDockedStates: true },
    });
    await r.localReply({ ...DOCKED, battery: 90 });
    expect(tile(r)).toEqual([CHARGING, RUN_IDLE]);

    await r.localReply({ ...DOCKED, battery: 90, state: 34 });

    expect(tile(r)).toEqual([CHARGING, RUN_IDLE]);
  });

  test("a mop swap in the middle of a room clean keeps the room list, and the run, as they were", async () => {
    const r = await robot({
      rooms: [
        { segmentId: 16, name: "Kitchen" },
        { segmentId: 17, name: "Hall" },
        { segmentId: 18, name: "Bedroom" },
      ],
    });
    await r.localReply(DOCKED);
    await r.accessory.handlers.serviceArea.selectAreas({ newAreas: [16] });
    await r.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await r.settle();
    expect(r.commands).toContain("app_segment_clean_by_ids");

    await r.localReply(clean({ state: 18, charge_status: 0 }));
    const before = r.store.read("serviceArea", "progress");
    expect(before).toEqual([{ areaId: 16, status: OPERATING }]);

    // The a144's own frame: state 33 at the dock, in_cleaning 3.
    await r.localReply(MOP_SWAP);
    expect(r.store.read("serviceArea", "progress")).toEqual(before);
    expect(r.store.read("rvcRunMode", "currentMode")).toBe(RUN_CLEANING);

    await r.localReply(clean({ state: 18, charge_status: 0 }));
    expect(r.store.read("serviceArea", "progress")).toEqual(before);
  });
});
