"use strict";

/**
 * A start sent to a paused robot resumes the paused run (#28).
 *
 * Apple Home's tile has a Resume button, and 3.40.0 made it continue a paused
 * room clean. An automation or a Shortcut has no Resume: it can only set the
 * run mode to Cleaning, which is a start. CooperCGN found that the start then
 * began a new clean instead of continuing the paused one.
 *
 * Home Assistant's Roborock integration answers a start on a paused robot
 * with the resume verb for the clean the robot says is paused, and so does the
 * plugin now — unless other rooms have been selected since, which is a new
 * clean.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

const KITCHEN = 16;
const HALL = 17;
const ROOMS = [
  { segmentId: KITCHEN, name: "Kitchen" },
  { segmentId: HALL, name: "Hall" },
];

const DOCKED = {
  state: 8,
  battery: 90,
  charge_status: 1,
  error_code: 0,
  in_cleaning: 0,
  fan_power: 102,
  water_box_mode: 200,
  clean_area: 0,
  clean_time: 0,
};
const ROOM_CLEAN = {
  ...DOCKED,
  state: 18,
  in_cleaning: 3,
  clean_area: 2500000,
  clean_time: 300,
};
const PAUSED_ROOM_CLEAN = { ...ROOM_CLEAN, state: 10 };
const WHOLE_HOME_CLEAN = { ...ROOM_CLEAN, state: 5, in_cleaning: 1 };
const PAUSED_WHOLE_HOME_CLEAN = { ...WHOLE_HOME_CLEAN, state: 10 };

// What the robot was told to do, without the clean-mode settings that go
// ahead of every start.
const STARTS = /^(app_start|app_segment_clean|resume_)/;
const starts = (robot) =>
  robot.commands.filter((command) => STARTS.test(command));

async function automationStart(robot) {
  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await robot.settle();
}

test("a room clean started from Apple Home and paused is resumed by an automation", async () => {
  const robot = await createRealApiVacuum({ rooms: ROOMS });
  await robot.localReply(DOCKED);
  await robot.accessory.handlers.serviceArea.selectAreas({
    newAreas: [KITCHEN, HALL],
  });
  await automationStart(robot);
  await robot.localReply(ROOM_CLEAN);
  await robot.accessory.handlers.rvcOperationalState.pause();
  await robot.settle();
  await robot.localReply(PAUSED_ROOM_CLEAN);

  await automationStart(robot);

  expect(starts(robot)).toEqual([
    "app_segment_clean_by_ids",
    "resume_segment_clean",
  ]);
});

test("a room clean started in the Roborock app and paused is resumed, not restarted as a whole-home clean", async () => {
  const robot = await createRealApiVacuum({ rooms: ROOMS });
  await robot.localReply(ROOM_CLEAN);
  await robot.localReply(PAUSED_ROOM_CLEAN);

  await automationStart(robot);

  expect(starts(robot)).toEqual(["resume_segment_clean"]);
});

test("a paused whole-home clean is continued with the plain start", async () => {
  const robot = await createRealApiVacuum({ rooms: ROOMS });
  await robot.localReply(WHOLE_HOME_CLEAN);
  await robot.localReply(PAUSED_WHOLE_HOME_CLEAN);

  await automationStart(robot);

  expect(starts(robot)).toEqual(["app_start"]);
  expect(robot.log.info).toHaveBeenCalledWith(
    expect.stringContaining("Resuming Rocky")
  );
});

test("other rooms selected while paused start a new clean of those rooms", async () => {
  const robot = await createRealApiVacuum({ rooms: ROOMS });
  await robot.localReply(DOCKED);
  await robot.accessory.handlers.serviceArea.selectAreas({
    newAreas: [KITCHEN, HALL],
  });
  await automationStart(robot);
  await robot.localReply(ROOM_CLEAN);
  await robot.localReply(PAUSED_ROOM_CLEAN);

  await robot.accessory.handlers.serviceArea.selectAreas({
    newAreas: [HALL],
  });
  await automationStart(robot);

  expect(starts(robot)).toEqual([
    "app_segment_clean_by_ids",
    "app_segment_clean_by_ids",
  ]);
});

test("a robot that is not paused is started as before", async () => {
  const robot = await createRealApiVacuum({ rooms: ROOMS });
  await robot.localReply(DOCKED);

  await automationStart(robot);

  expect(starts(robot)).toEqual(["app_start"]);
});
