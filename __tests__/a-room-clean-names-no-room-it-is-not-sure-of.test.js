"use strict";

/**
 * A selected-room start used to name the first requested room as the room
 * the robot was in, and show it Operating with the others Pending, until live
 * tracking said otherwise. On a robot without live rooms (a Q10, or a classic
 * robot whose `get_map_v1` goes unanswered) it said so for the whole run:
 * Marrand's S8 in #24 — "Matter still shows the loading/progress indicator on
 * Kitchen" while the robot cleaned other rooms.
 *
 * The rule the full-home start already follows applies: no room is named that
 * the plugin is not sure of. Every requested room is Operating, none is
 * current, and live tracking narrows it the moment it resolves a room.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

const OPERATING = 1;

test("a selected-room start names no room until the robot is seen in one", async () => {
  const robot = await createRealApiVacuum({
    rooms: [
      { segmentId: 16, name: "Kitchen" },
      { segmentId: 17, name: "Hall" },
      { segmentId: 18, name: "Bedroom" },
    ],
  });
  await robot.localReply({ state: 8, battery: 90, charge_status: 1 });

  await robot.accessory.handlers.serviceArea.selectAreas({
    newAreas: [16, 17],
  });
  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await robot.settle();

  expect(robot.store.read("serviceArea", "currentArea")).toBeNull();
  expect(robot.store.read("serviceArea", "progress")).toEqual([
    { areaId: 16, status: OPERATING },
    { areaId: 17, status: OPERATING },
  ]);
});
