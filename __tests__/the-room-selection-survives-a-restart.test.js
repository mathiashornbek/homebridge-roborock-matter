"use strict";

/**
 * Pick three rooms in Apple Home, restart Homebridge, and the selection was
 * gone: the first publish said `selectedAreas: []`, Apple Home snapped back to
 * "no rooms", and Start cleaned the whole house. The maintainer's own log shows
 * three restarts in four days.
 *
 * The accessory kept its room progress in `accessory.context`, on the
 * understanding that Homebridge persists it. For an external Matter accessory
 * — every robot vacuum — Homebridge 2.4.0 saves that context but loads its
 * cache only after the accessory has registered (ServerLifecycle.runServer ->
 * startServerNode), so nothing in it ever came back. The selection was not
 * even kept there.
 *
 * The platform now keeps the Matter accessories' context itself, across a
 * shutdown, and hands it to the accessory before its registration defaults are
 * built.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const RoborockPlatform = require("../src/platform").default;
const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const DUID = "device-selection";
const ROOMS = [
  { segmentId: 16, mapId: 0, name: "Kitchen" },
  { segmentId: 17, mapId: 0, name: "Hall" },
  { segmentId: 18, mapId: 0, name: "Bedroom" },
];

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/** One Homebridge run: a platform over the given storage directory. */
function startHomebridge(storagePath) {
  const platform = Object.create(RoborockPlatform.prototype);
  platform.log = createLog();
  platform.platformConfig = { enableMatter: true };
  platform.accessories = [];
  platform.api = {
    hap: { uuid: { generate: (seed) => `uuid-${seed}` } },
    user: { storagePath: () => storagePath },
    unregisterPlatformAccessories: jest.fn(),
  };
  platform.matterAccessories = [];
  platform.matterVacuums = new Map();
  platform.stateSensors = new Map();
  platform.shouldAcceptUnscopedLiveMessage = () => true;
  platform.refreshStateSensorsForRobot = () => {};
  platform.roborockAPI = {
    getVacuumDeviceInfo: (_duid, property) =>
      property === "name" ? "Rocky" : "",
    getProductAttribute: () => "roborock.vacuum.a70",
    getVacuumDeviceStatus: (_duid, property) =>
      ({ state: 8, battery: 100, charge_status: 1, error_code: 0 })[property] ??
      "",
    getRoomMappingsForDevice: () => ROOMS.map((room) => ({ ...room })),
    getMapListForDevice: () => [{ mapId: 0, name: "Home" }],
    getCurrentMapIdForDevice: () => 0,
    getMatterCleanModeCapabilities: () => ({ canVacuum: true }),
    describeDevice: () => "Rocky",
    getStatus: jest.fn().mockResolvedValue(undefined),
  };

  const homebridge = { store: null };
  platform.getMatterApi = () => ({
    deviceTypes: { RoboticVacuumCleaner: "rvc" },
    // Homebridge 2.4.0: the endpoint starts from accessory.clusters and
    // nothing cached is restored over it.
    registerPlatformAccessories: async (_plugin, _platform, list) => {
      homebridge.store = createMatterStore(list[0].clusters);
    },
    updatePlatformAccessories: async () => undefined,
    updateAccessoryState: (...args) =>
      homebridge.store.updateAccessoryState(...args),
    getAccessoryState: (...args) => homebridge.store.getAccessoryState(...args),
  });
  return { platform, homebridge };
}

async function discover(platform) {
  await platform.discoverMatterVacuum({
    duid: DUID,
    name: "Rocky",
    pv: "1.0",
    online: true,
  });
  return platform.matterVacuums.get(DUID);
}

const running = [];
afterEach(() => {
  for (const vacuum of running.splice(0)) {
    vacuum.dispose();
  }
});

test("the rooms picked before a restart are still picked after it", async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "selection-"));

  const before = startHomebridge(storagePath);
  const vacuum = await discover(before.platform);
  running.push(vacuum);
  await vacuum.accessory.handlers.serviceArea.selectAreas({
    newAreas: [16, 18],
  });
  // What the SHUTDOWN handler runs.
  before.platform.saveMatterAccessoryContexts();
  vacuum.dispose();

  const after = startHomebridge(storagePath);
  running.push(await discover(after.platform));

  expect(after.homebridge.store.read("serviceArea", "selectedAreas")).toEqual([
    16, 18,
  ]);
});

test("a run in progress keeps its room list across a restart", async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "progress-"));

  const before = startHomebridge(storagePath);
  const vacuum = await discover(before.platform);
  running.push(vacuum);
  await vacuum.accessory.handlers.serviceArea.selectAreas({ newAreas: [17] });
  await vacuum.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  before.platform.saveMatterAccessoryContexts();
  vacuum.dispose();

  const after = startHomebridge(storagePath);
  running.push(await discover(after.platform));

  expect(after.homebridge.store.read("serviceArea", "progress")).toEqual([
    { areaId: 17, status: 1 },
  ]);
});

test("no saved context, or an unreadable one, starts clean", async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "nothing-"));
  fs.writeFileSync(
    path.join(storagePath, "roborock.MatterAccessoryContext"),
    "{ not json"
  );

  const { platform, homebridge } = startHomebridge(storagePath);
  running.push(await discover(platform));

  expect(homebridge.store.read("serviceArea", "selectedAreas")).toEqual([]);
  expect(platform.log.error).not.toHaveBeenCalled();
});
