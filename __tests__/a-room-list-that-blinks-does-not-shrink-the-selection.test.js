"use strict";

/**
 * Building the serviceArea cluster used to trim the stored selection to the
 * rooms in the current list. The cluster is built on every publish, and the
 * room list is momentarily partial while a map refreshes, so one partial read
 * dropped the missing rooms from the selection for good: Apple Home showed
 * them deselected, and Start cleaned fewer rooms than were picked. What is
 * published is still filtered — matter.js refuses a selection naming an
 * unknown room — but the selection itself is the user's and stays.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

test("a room missing from one read of the list is selected again when it is back", async () => {
  const robot = await createRealApiVacuum({
    rooms: [
      { segmentId: 16, name: "Kitchen" },
      { segmentId: 17, name: "Hall" },
    ],
  });
  await robot.localReply({ state: 8, battery: 90, charge_status: 1 });
  await robot.accessory.handlers.serviceArea.selectAreas({
    newAreas: [16, 17],
  });
  await robot.settle();
  expect(robot.store.read("serviceArea", "selectedAreas")).toEqual([16, 17]);

  // A map refresh: for one publish the robot's room list lacks the hall.
  const rooms = robot.api.roomMappings[robot.duid].roomsByMap[0];
  robot.api.roomMappings[robot.duid].roomsByMap[0] = [rooms[0]];
  await robot.localReply({ state: 8, battery: 89, charge_status: 1 });
  expect(robot.store.read("serviceArea", "selectedAreas")).toEqual([16]);

  robot.api.roomMappings[robot.duid].roomsByMap[0] = rooms;
  await robot.localReply({ state: 8, battery: 88, charge_status: 1 });
  expect(robot.store.read("serviceArea", "selectedAreas")).toEqual([16, 17]);

  await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await robot.settle();
  expect(robot.api.vacuums[robot.duid].command).toHaveBeenCalledWith(
    robot.duid,
    "app_segment_clean_by_ids",
    expect.objectContaining({ segments: [16, 17] }),
    expect.anything()
  );
});
