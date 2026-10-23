"use strict";

/**
 * Homebridge builds a robot's Matter endpoint once, from accessory.clusters
 * at registration, and its cluster set never changes after that. A robot
 * registered before its rooms were known (a first start whose room read had
 * not answered yet; every Q10, whose rooms arrive in a map push) has no
 * Service Area, and Homebridge 2.4.0 refuses a write to it with two ERROR
 * lines ("[endpoint-behavior-not-present] Behavior "serviceArea" is not
 * present", "Failed to update Matter accessory state") — on every status
 * frame and every heartbeat, until a restart. The read-back says which
 * clusters the endpoint has; one it lacks is not written, and the user is
 * told once what makes it appear.
 */

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

afterEach(() => disposeRealApiVacuums());

const DOCKED = {
  state: 8,
  battery: 90,
  charge_status: 1,
  error_code: 0,
  in_cleaning: 0,
  fan_power: 102,
  water_box_mode: 200,
};

const restartLines = (log) =>
  log.info.mock.calls
    .map(([line]) => String(line))
    .filter((line) => /restart Homebridge/i.test(line));

test("rooms that arrive after registration are not written, and the user is told once to restart", async () => {
  const robot = await createRealApiVacuum({ rooms: [] });
  expect(robot.accessory.clusters.serviceArea).toBeUndefined();
  await robot.localReply(DOCKED);
  await robot.settle();

  // The room read answers after registration.
  robot.api.roomMappings[robot.duid] = {
    currentMapId: 0,
    maps: [{ mapId: 0, name: "Home" }],
    roomsByMap: { 0: [{ segmentId: 16, name: "Kitchen", mapId: 0 }] },
  };
  for (let i = 0; i < 3; i += 1) {
    await robot.localReply(DOCKED);
    await robot.settle();
  }

  expect(
    robot.store.writes.filter(({ cluster }) => cluster === "serviceArea")
  ).toEqual([]);
  expect(robot.store.rejected).toEqual([]);
  expect(restartLines(robot.log)).toHaveLength(1);
  expect(restartLines(robot.log)[0]).toMatch(/Rocky/);
  expect(restartLines(robot.log)[0]).toMatch(/rooms/);
  // Everything the endpoint does have is still published.
  expect(robot.store.read("powerSource", "batPercentRemaining")).toBe(180);
});

test("a store that cannot see the robot at all is still written, as before the read-back", async () => {
  // A mandatory cluster that reads back as absent means the store cannot see
  // this accessory, not that the endpoint lacks the cluster.
  const writes = [];
  const matter = {
    updateAccessoryState: async (_uuid, cluster) => {
      writes.push(cluster);
    },
    getAccessoryState: async () => undefined,
  };
  const platform = {
    platformConfig: { enableMatter: true },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => matter,
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (_d, p) => (p === "name" ? "Rocky" : ""),
      getProductAttribute: () => "roborock.vacuum.a70",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => [],
      getMatterCleanModeCapabilities: () => ({ canVacuum: true }),
    },
  };
  const accessory = { UUID: "uuid-unseen", context: { duid: "d" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "d" },
    true
  );
  try {
    await vacuum.updateMatterStateFromRoborock();
    expect(writes).toEqual(
      expect.arrayContaining(["rvcRunMode", "rvcOperationalState"])
    );
    expect(restartLines(platform.log)).toEqual([]);
  } finally {
    vacuum.dispose();
  }
});
