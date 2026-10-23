"use strict";

/**
 * A room clean stopped from Apple Home ends with the rooms the robot was not
 * seen cleaning Skipped. That settlement happens once: the next poll, a few
 * seconds later with nothing changed, used to settle the run again — now as
 * a normal end — and turned every Skipped room Completed. A restart did the
 * same to a restored list on its first status.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(() => {
  disposeRealApiVacuums();
  jest.useRealTimers();
});

const SKIPPED = 2;
const COMPLETED = 3;
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
  charge_status: 0,
  in_cleaning: 3,
  clean_area: 2500000,
  clean_time: 300,
};
const IDLE_AFTER_STOP = { ...ROOM_CLEAN, state: 3 };

test("the Skipped rooms of a stopped run stay Skipped on the next poll", async () => {
  const robot = await createRealApiVacuum({ rooms: ROOMS });
  await robot.localReply(DOCKED);
  await robot.accessory.handlers.serviceArea.selectAreas({
    newAreas: [KITCHEN, HALL],
  });
  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await robot.settle();
  await robot.localReply(ROOM_CLEAN);

  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 0 });
  await robot.settle();
  await robot.localReply(IDLE_AFTER_STOP);
  const settled = [
    { areaId: KITCHEN, status: SKIPPED },
    { areaId: HALL, status: SKIPPED },
  ];
  expect(robot.store.read("serviceArea", "progress")).toEqual(settled);

  // The next polls: nothing has changed.
  await robot.localReply(IDLE_AFTER_STOP);
  await robot.localReply(DOCKED);
  expect(robot.store.read("serviceArea", "progress")).toEqual(settled);
});

test("a restored run that was already settled keeps its Skipped and Completed rooms", async () => {
  const restored = [
    { areaId: KITCHEN, status: COMPLETED },
    { areaId: HALL, status: SKIPPED },
  ];
  const robot = await createRealApiVacuum({
    rooms: ROOMS,
    savedContext: {
      serviceAreaProgressState: { currentArea: null, progress: restored },
    },
  });
  await robot.localReply(DOCKED);
  await robot.settle();
  expect(robot.store.read("serviceArea", "progress")).toEqual(restored);
});

test("a Skipped room stays Skipped when the rest of its run completes", async () => {
  // A list restored with one room already settled Skipped and one still
  // operating (Homebridge was down when the run ended): the operating one
  // completes; the Skipped one was not cleaned and stays so.
  const robot = await createRealApiVacuum({
    rooms: ROOMS,
    savedContext: {
      serviceAreaProgressState: {
        currentArea: null,
        progress: [
          { areaId: KITCHEN, status: SKIPPED },
          { areaId: HALL, status: 1 },
        ],
      },
    },
  });
  await robot.localReply(DOCKED);
  await robot.settle();
  expect(robot.store.read("serviceArea", "progress")).toEqual([
    { areaId: KITCHEN, status: SKIPPED },
    { areaId: HALL, status: COMPLETED },
  ]);
});

test("a restored run that was still going completes when the robot is found docked", async () => {
  // Unchanged: a run that ended while Homebridge was down is a run that ended.
  const robot = await createRealApiVacuum({
    rooms: ROOMS,
    savedContext: {
      serviceAreaProgressState: {
        currentArea: null,
        progress: [
          { areaId: KITCHEN, status: 1 },
          { areaId: HALL, status: 1 },
        ],
      },
    },
  });
  await robot.localReply(DOCKED);
  await robot.settle();
  expect(robot.store.read("serviceArea", "progress")).toEqual([
    { areaId: KITCHEN, status: COMPLETED },
    { areaId: HALL, status: COMPLETED },
  ]);
});
