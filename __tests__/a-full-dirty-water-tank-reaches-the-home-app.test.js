"use strict";

/**
 * #26: "Can the dirty water tank be a state, like clean water tank empty?"
 *
 * It can. Matter's RVC ErrorStateEnum has DirtyWaterTankFull (74) and
 * DirtyWaterTankMissing (75) since cluster revision 3 (Matter 1.4.2), and
 * matter.js 0.17.9 — the build Homebridge 2.4.0 ships — defines and accepts
 * both (@matter/types rvc-operational-state ErrorState). The plugin already
 * decoded the condition for its HAP sensor and published nothing to Matter.
 *
 * What the robot says, after python-roborock: the dock word `dss` carries the
 * dirty tank at bits 4-5, where 1 is `full_not_installed`, and
 * `dock_error_status` 39 is `waste_water_tank_full` ("check tank placement or
 * empty as required"). Neither separates a full tank from a missing one, so
 * 74 is published for both and 75 never is.
 *
 * It is a blocking condition exactly like the clean tank: published for a
 * robot at rest, held back while it cleans (a fault forces Error in matter.js,
 * #35), and not asserted for a run chosen as vacuum-only.
 *
 * Built from n0rt0nthec4t's own capture (Qrevo S, a104, 18 Oct 2026): mid
 * room clean, `dss` 153 = clean tank fine (2), dirty tank full (1).
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

const DIRTY_WATER_TANK_FULL = 74;
const WATER_TANK_EMPTY = 68;
const NO_ERROR = 0;
const ERROR = 3;

// The reporter's get_status reply (issue #26, 2026-10-18), as far as the
// diagnostic report kept it.
const MID_RUN_DIRTY_FULL = {
  msg_ver: 2,
  msg_seq: 498,
  state: 18,
  battery: 89,
  clean_time: 1056,
  clean_area: 18427500,
  error_code: 0,
  map_present: 1,
  in_cleaning: 3,
  in_returning: 0,
  in_fresh_state: 0,
  lab_status: 1,
  water_box_status: 1,
  fan_power: 102,
  dnd_enabled: 0,
  map_status: 3,
  is_locating: 0,
  lock_status: 0,
  water_box_mode: 202,
  distance_off: 0,
  water_box_carriage_status: 1,
  mop_forbidden_enable: 1,
  camera_status: 1,
  is_exploring: 0,
  water_shortage_status: 0,
  dock_type: 15,
  dust_collection_status: 0,
  auto_dust_collection: 1,
  avoid_count: 0,
  mop_mode: 300,
  wash_status: 256,
  dock_error_status: 0,
  charge_status: 1,
  rss: 2,
  dss: 153,
};
const DOCKED_DIRTY_FULL = {
  ...MID_RUN_DIRTY_FULL,
  state: 8,
  in_cleaning: 0,
  battery: 95,
};
// The same dock with the dirty tank emptied: dss field back to 2 ("fine").
const DOCKED_EMPTIED = { ...DOCKED_DIRTY_FULL, dss: 169 };

async function qrevoS(platformConfig = {}) {
  return createRealApiVacuum({
    model: "roborock.vacuum.a104",
    platformConfig,
  });
}

const fault = (robot) =>
  robot.store.read("rvcOperationalState", "operationalError").errorStateId;

describe("a full dirty-water tank reaches the Home app", () => {
  test("docked with the dirty tank full: DirtyWaterTankFull, accepted by matter.js, one event", async () => {
    const robot = await qrevoS();

    await robot.localReply(DOCKED_DIRTY_FULL);

    expect(fault(robot)).toBe(DIRTY_WATER_TANK_FULL);
    expect(robot.store.read("rvcOperationalState", "operationalState")).toBe(
      ERROR
    );
    expect(robot.store.rejected).toEqual([]);
    expect(robot.store.events).toEqual([
      { errorStateId: DIRTY_WATER_TANK_FULL },
    ]);
    expect(robot.log.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "fault=74 (Dirty water tank full: full, or not fitted"
      )
    );
  });

  test("mid-run it is held back, and raised once the robot is home", async () => {
    const robot = await qrevoS();

    await robot.localReply(MID_RUN_DIRTY_FULL);
    expect(fault(robot)).toBe(NO_ERROR);

    await robot.localReply(DOCKED_DIRTY_FULL);
    expect(fault(robot)).toBe(DIRTY_WATER_TANK_FULL);
    expect(robot.store.events).toHaveLength(1);
  });

  test("emptying it clears it", async () => {
    const robot = await qrevoS();
    await robot.localReply(DOCKED_DIRTY_FULL);

    await robot.localReply(DOCKED_EMPTIED);

    expect(fault(robot)).toBe(NO_ERROR);
    expect(robot.store.events).toHaveLength(1);
  });

  test("a dock without the status word says it with dock_error_status 39", async () => {
    const robot = await qrevoS();

    await robot.localReply({
      ...DOCKED_DIRTY_FULL,
      dss: 0,
      dock_error_status: 39,
    });

    expect(fault(robot)).toBe(DIRTY_WATER_TANK_FULL);
  });

  test("an empty clean tank outranks it: one fault at a time, and 68 is the measured one", async () => {
    const robot = await qrevoS();

    // dss 149: clean tank 1 (empty), dirty tank 1 (full).
    await robot.localReply({ ...DOCKED_DIRTY_FULL, dss: 149 });

    expect(fault(robot)).toBe(WATER_TANK_EMPTY);
  });

  test("a vacuum-only choice does not assert it", async () => {
    const robot = await qrevoS();
    await robot.localReply({ ...DOCKED_DIRTY_FULL, dss: 169 });

    await robot.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 0 });
    await robot.settle();
    await robot.localReply(DOCKED_DIRTY_FULL);

    expect(fault(robot)).toBe(NO_ERROR);
    expect(robot.store.events).toHaveLength(0);
  });

  test("`false` for the fault attribute still switches it off", async () => {
    const robot = await qrevoS({ enableMatterTankFaultReporting: false });

    await robot.localReply(DOCKED_DIRTY_FULL);

    expect(robot.store.events).toHaveLength(0);
  });
});
