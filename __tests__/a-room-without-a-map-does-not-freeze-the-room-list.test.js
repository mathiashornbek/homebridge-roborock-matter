"use strict";

/**
 * roborockLib files a room under map -1 when a status reply had no
 * `map_status` (lib/vacuum.js), and that bucket is persisted. One such room
 * beside rooms on a real map produced an area with no map next to areas on
 * map 0, and matter.js 0.17.9 refuses that whole serviceArea write ("Areas
 * must not have a null mapId when supportedMaps is defined",
 * ServiceAreaServer#assertSupportedAreas) — every write, so the room list,
 * the selection and the live room all froze, and at the next restart the
 * endpoint itself could not register.
 *
 * A room that belongs to no map cannot be cleaned from a map-based selection
 * anyway, so while real maps exist it is left out, and said once.
 */

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { createMatterStore } = require("../test-support/matter-0.17.9-store");

function make(rooms) {
  let store;
  const platform = {
    platformConfig: {},
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => store,
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (d, p) => (p === "name" ? "Rocky" : ""),
      getProductAttribute: () => "roborock.vacuum.a70",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => rooms,
      getMapListForDevice: () => [
        { mapId: 0, name: "Home" },
        { mapId: -1, name: "Roborock Map -1" },
      ],
      getCurrentMapIdForDevice: () => 0,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true }),
    },
  };
  const accessory = { UUID: "u", context: { duid: "d" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "d" },
    true
  );
  store = createMatterStore({
    // An RVC endpoint always has its run mode and operational state.
    ...accessory.clusters,
    serviceArea: {
      supportedAreas: [],
      supportedMaps: [],
      selectedAreas: [],
      currentArea: null,
      progress: [],
    },
  });
  return { vacuum, accessory, platform, store: () => store };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a room filed under no map", () => {
  test("is left out while real maps exist, so the room list is accepted", async () => {
    const { vacuum, accessory, platform, store } = make([
      { segmentId: 16, mapId: -1, name: "Kitchen" },
      { segmentId: 17, mapId: 0, name: "Hall" },
    ]);

    expect(
      accessory.clusters.serviceArea.supportedAreas.map((area) => area.mapId)
    ).toEqual([0]);

    await vacuum.notifyDeviceUpdater("LocalMessage", {
      duid: "d",
      payload: [{ state: 8, battery: 90, charge_status: 1 }],
    });
    vacuum.dispose();

    expect(store().rejected).toEqual([]);
    expect(
      store()
        .read("serviceArea", "supportedAreas")
        .map((area) => area.areaInfo.locationInfo.locationName)
    ).toEqual(["Hall"]);
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Kitchen")
    );
  });

  test("a robot whose rooms all have no map keeps them", () => {
    const { accessory, vacuum } = make([
      { segmentId: 16, mapId: -1, name: "Kitchen" },
      { segmentId: 17, mapId: -1, name: "Hall" },
    ]);
    vacuum.dispose();

    expect(
      accessory.clusters.serviceArea.supportedAreas.map((area) => area.mapId)
    ).toEqual([null, null]);
  });
});
