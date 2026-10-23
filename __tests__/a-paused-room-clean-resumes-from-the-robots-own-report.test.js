"use strict";

/**
 * #28, the half that never reached production.
 *
 * 3.35.0 taught the Resume handler to read the robot's own `in_cleaning`
 * (python-roborock `RoborockInCleaning`: 0 complete, 1 whole-home, 2 zone,
 * 3 room clean not complete) and send `resume_segment_clean` for a paused room
 * clean. The tests that pinned it stubbed `getVacuumDeviceStatus` with
 * `in_cleaning`. Production cannot answer that way: the cloud's HomeData
 * snapshot is keyed by schema id and has no `in_cleaning` at all, and the
 * accessory never remembered the field from the robot's own `get_status`
 * reply. So the value was always unknown, Resume always sent `app_start`, and
 * CooperCGN's paused room clean still restarted as a whole-home clean.
 *
 * These tests use the real Roborock API with a cloud-shaped HomeData, and his
 * own capture of the paused S8 (#28, 6 Oct 2026), delivered the way the local
 * connector delivers a reply.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

// CooperCGN's `get_status` reply from the S8, paused in the middle of a room
// clean (issue #28, 2026-10-06).
const PAUSED_ROOM_CLEAN = {
  msg_ver: 2,
  msg_seq: 764,
  state: 10,
  battery: 93,
  clean_time: 65,
  clean_area: 1007500,
  error_code: 0,
  map_present: 1,
  in_cleaning: 3,
  in_returning: 0,
  in_fresh_state: 0,
  lab_status: 1,
  water_box_status: 1,
  fan_power: 103,
  dnd_enabled: 0,
  map_status: 3,
  is_locating: 0,
  lock_status: 0,
  water_box_mode: 200,
  water_box_carriage_status: 1,
  mop_forbidden_enable: 1,
  camera_status: 385,
  is_exploring: 0,
  adbumper_status: [0, 0, 0],
  water_shortage_status: 0,
  dock_type: 5,
  dust_collection_status: 0,
  auto_dust_collection: 1,
  avoid_count: 0,
  mop_mode: 300,
  debug_mode: 0,
  collision_avoid_status: 1,
  switch_map_mode: 0,
  dock_error_status: 0,
  charge_status: 1,
  unsave_map_reason: 0,
  unsave_map_flag: 0,
  clean_percent: 99,
  rss: 2,
  dss: 128,
  replenish_mode: 0,
  repeat: 1,
};

const ROOM_CLEAN = { ...PAUSED_ROOM_CLEAN, state: 18, msg_seq: 760 };

async function pauseThenResume(running, paused) {
  const robot = await createRealApiVacuum({ model: "roborock.vacuum.a51" });
  await robot.localReply(running);

  await robot.accessory.handlers.rvcOperationalState.pause();
  await robot.settle();
  await robot.localReply(paused);

  await robot.accessory.handlers.rvcOperationalState.resume();
  await robot.settle();
  return robot;
}

describe("Resume continues the clean the robot itself says is paused", () => {
  test("a paused room clean is resumed as a room clean, end to end", async () => {
    const robot = await pauseThenResume(ROOM_CLEAN, PAUSED_ROOM_CLEAN);

    // Proves the premise: the cloud snapshot really cannot answer.
    expect(robot.api.getVacuumDeviceStatus(robot.duid, "in_cleaning")).toBe("");
    expect(robot.commands).toContain("app_pause");
    expect(robot.commands).toContain("resume_segment_clean");
    expect(robot.commands).not.toContain("app_start");
  });

  test("a paused zone clean is resumed as a zone clean", async () => {
    const robot = await pauseThenResume(
      { ...ROOM_CLEAN, state: 17, in_cleaning: 2 },
      { ...PAUSED_ROOM_CLEAN, in_cleaning: 2 }
    );

    expect(robot.commands).toContain("resume_zoned_clean");
    expect(robot.commands).not.toContain("app_start");
  });

  test("a paused whole-home clean still gets the plain start", async () => {
    const robot = await pauseThenResume(
      { ...ROOM_CLEAN, state: 5, in_cleaning: 1 },
      { ...PAUSED_ROOM_CLEAN, in_cleaning: 1 }
    );

    expect(robot.commands).toContain("app_start");
    expect(robot.commands).not.toContain("resume_segment_clean");
    expect(robot.commands).not.toContain("resume_zoned_clean");
  });

  test("the debug line names the value the robot reported", async () => {
    const robot = await pauseThenResume(ROOM_CLEAN, PAUSED_ROOM_CLEAN);

    expect(robot.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("in_cleaning=3, sending resume_segment_clean")
    );
  });
});
