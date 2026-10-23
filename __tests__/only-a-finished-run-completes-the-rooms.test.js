"use strict";

/**
 * The end of a run used to mark every requested area Completed, whatever
 * ended it: any status outside a cleaning run did it. So a room clean whose
 * start the robot refused (bin full, robot offline, the cloud link dropped
 * before the command went out — #24's failed clean) was reported cleaned, a
 * Stop from Apple Home reported the rooms the robot never reached as cleaned,
 * and a robot that got stuck mid-run was told it had finished.
 *
 * Matter has a value for a room that was not done — Skipped — and the plugin
 * knows which of these happened: whether the robot was ever seen running
 * after the start, whether Matter asked it to stop, and whether it halted.
 *
 * Real Roborock API; replies shaped like the robot's own `get_status`.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const {
  createRefusalError,
  describeReplyRefusal,
} = require("../roborockLib/lib/describeReplyRefusal");

afterEach(() => {
  disposeRealApiVacuums();
  jest.useRealTimers();
});

const OPERATING = 1;
const SKIPPED = 2;
const COMPLETED = 3;
const RUN_IDLE = 0;
const RUN_CLEANING = 1;

const KITCHEN = 16;
const HALL = 17;

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
  charge_status: 0,
  in_cleaning: 3,
  clean_area: 2500000,
  clean_time: 300,
};

async function robotWithRooms() {
  const robot = await createRealApiVacuum({
    rooms: [
      { segmentId: KITCHEN, name: "Kitchen" },
      { segmentId: HALL, name: "Hall" },
    ],
  });
  await robot.localReply(DOCKED);
  return robot;
}

async function startRoomClean(robot, rooms) {
  await robot.accessory.handlers.serviceArea.selectAreas({ newAreas: rooms });
  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await robot.settle();
}

const progress = (robot) => robot.store.read("serviceArea", "progress");

describe("only a finished run completes the rooms", () => {
  test("a start the robot refused puts back what was there", async () => {
    const robot = await robotWithRooms();
    const reply = { id: 7, error: { code: -10007, message: "invalid status" } };
    robot.api.vacuums[robot.duid].command = jest.fn(async (_duid, method) => {
      if (method === "app_segment_clean_by_ids") {
        throw createRefusalError(
          `The robot refused app_segment_clean (local id 7): ${describeReplyRefusal(reply)}`,
          reply
        );
      }
      return ["ok"];
    });

    await startRoomClean(robot, [KITCHEN]);
    await robot.settle();
    expect(progress(robot)).toEqual([]);

    await robot.localReply(DOCKED);
    expect(progress(robot)).toEqual([]);
  });

  test("a start the robot acknowledged and never acted on is not reported cleaned", async () => {
    jest.useFakeTimers({
      now: Date.UTC(2026, 9, 23, 10, 0, 0),
      doNotFake: ["nextTick", "setImmediate"],
    });
    const robot = await robotWithRooms();
    await startRoomClean(robot, [KITCHEN]);

    // Still docked a few seconds later: the robot is starting, or not.
    await robot.localReply(DOCKED);
    expect(progress(robot)).not.toContainEqual({
      areaId: KITCHEN,
      status: COMPLETED,
    });

    // Still docked a minute and more later: it did not start.
    await jest.advanceTimersByTimeAsync(70 * 1000);
    await robot.localReply(DOCKED);
    await robot.localReply(DOCKED);

    expect(progress(robot)).toEqual([]);
  });

  test("a run that ends at the dock completes every room", async () => {
    const robot = await robotWithRooms();
    await startRoomClean(robot, [KITCHEN, HALL]);

    await robot.localReply(ROOM_CLEAN);
    await robot.localReply({ ...ROOM_CLEAN, state: 6 });
    await robot.localReply({ ...DOCKED, in_cleaning: 0 });

    expect(progress(robot)).toEqual([
      { areaId: KITCHEN, status: COMPLETED },
      { areaId: HALL, status: COMPLETED },
    ]);
  });

  test("a Stop from Apple Home marks the rooms the robot was not seen in as skipped", async () => {
    const robot = await robotWithRooms();
    await startRoomClean(robot, [KITCHEN, HALL]);
    await robot.localReply(ROOM_CLEAN);

    await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 0 });
    await robot.settle();
    await robot.localReply({ ...ROOM_CLEAN, state: 3 });

    expect(progress(robot)).toEqual([
      { areaId: KITCHEN, status: SKIPPED },
      { areaId: HALL, status: SKIPPED },
    ]);
  });

  test("a robot that halts mid-run has not finished: rooms and run mode stay as they were", async () => {
    const robot = await robotWithRooms();
    await startRoomClean(robot, [KITCHEN]);
    await robot.localReply(ROOM_CLEAN);
    const during = progress(robot);
    expect(during).toEqual([{ areaId: KITCHEN, status: OPERATING }]);

    // Stuck under the sofa: state 12, error_code 8 "robot trapped".
    await robot.localReply({ ...ROOM_CLEAN, state: 12, error_code: 8 });
    expect(progress(robot)).toEqual(during);
    expect(robot.store.read("rvcRunMode", "currentMode")).toBe(RUN_CLEANING);

    // Freed, it carries on and finishes.
    await robot.localReply(ROOM_CLEAN);
    await robot.localReply({ ...DOCKED, in_cleaning: 0 });
    expect(progress(robot)).toEqual([{ areaId: KITCHEN, status: COMPLETED }]);
    expect(robot.store.read("rvcRunMode", "currentMode")).toBe(RUN_IDLE);
  });
});
