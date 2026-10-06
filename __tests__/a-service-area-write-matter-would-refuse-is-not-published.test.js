"use strict";

/**
 * Every Service Area write is one matter.js transaction, and @matter/node
 * 0.17.9 validates it (src/behaviors/service-area/ServiceAreaServer.ts):
 *
 *   :92-133  supportedAreas need a unique AreaInfo per map — two rooms called
 *            "Bedroom" on one map are refused;
 *   :172-183 every progress entry must name a supported area.
 *
 * A refused write is rolled back whole and Homebridge 2.4.0 only logs it
 * (StateManager.js:125-129) — the plugin's promise has already resolved
 * (MatterAPIImpl.js:337-357), so lastPublishedClusterJson records it as
 * published and only the heartbeat retries it, to be refused again. The
 * controller keeps the cluster as it was at registration: rooms, selection,
 * progress and the live "cleaning in <room>" all stop updating. At
 * registration time the same input fails the endpoint outright
 * ("Behaviors have errors", measured on the real 0.17.9 library).
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

function harness({ rooms, context = {} }) {
  let store;
  const platform = {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    platformConfig: { enableMatter: true },
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Q7" : "",
      getProductAttribute: () => "roborock.vacuum.sc01",
      getVacuumDeviceStatus: (duid, property) =>
        ({ state: 8, battery: 100, charge_status: 1, error_code: 0 })[
          property
        ] ?? "",
      getRoomMappingsForDevice: () => rooms,
      getMapListForDevice: () => [{ mapId: 0, name: "Home" }],
      getCurrentMapIdForDevice: () => 0,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
  const accessory = {
    UUID: "uuid-sa",
    context: { duid: "device-sa", ...context },
  };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-sa" },
    true
  );
  return {
    vacuum,
    accessory,
    makeStore: (initial) => (store = createMatterStore(initial)),
  };
}

const KITCHEN_AND_HALL = [
  { segmentId: 16, mapId: 0, name: "Kitchen" },
  { segmentId: 17, mapId: 0, name: "Hall" },
];

describe("a Service Area write matter.js would refuse is not published", () => {
  test("progress left over from a room that has since been merged away", async () => {
    // Persisted by persistServiceAreaProgress() after the last run, when the
    // map still had a room 18. The user then merged it in the Roborock app.
    const { vacuum, accessory, makeStore } = harness({
      rooms: KITCHEN_AND_HALL,
      context: {
        serviceAreaProgressState: {
          currentArea: null,
          progress: [
            { areaId: 16, status: 3 },
            { areaId: 18, status: 3 },
          ],
        },
      },
    });
    const store = makeStore(accessory.clusters);

    await vacuum.updateMatterStateFromRoborock();
    vacuum.dispose();

    // Fails on 3.34.0: restoreServiceAreaProgress() restores area 18 without
    // checking it against supportedAreas, and the whole write is refused.
    expect(store.rejected.map((r) => `${r.cluster}: ${r.error}`)).toEqual([]);
  });

  test("two rooms with the same name on one map", async () => {
    const { vacuum, accessory } = harness({
      rooms: [
        { segmentId: 16, mapId: 0, name: "Bedroom" },
        { segmentId: 17, mapId: 0, name: "Bedroom" },
      ],
    });
    vacuum.dispose();

    // What Homebridge would construct the endpoint from. Replaying it as a
    // write runs the same validator initialize() runs (ServiceAreaServer.ts:37).
    const store = createMatterStore({ serviceArea: { supportedAreas: [] } });
    await store.updateAccessoryState("uuid-sa", "serviceArea", {
      supportedMaps: accessory.clusters.serviceArea.supportedMaps,
      supportedAreas: accessory.clusters.serviceArea.supportedAreas,
    });

    // Fails on 3.34.0: both areas carry locationName "Bedroom" on map 0.
    expect(store.rejected.map((r) => r.error)).toEqual([]);
  });
});

describe("duplicate room names stay readable", () => {
  test("the second Bedroom is Bedroom 2, and the first keeps its name", () => {
    const { vacuum, accessory } = harness({
      rooms: [
        { segmentId: 16, mapId: 0, name: "Bedroom" },
        { segmentId: 17, mapId: 0, name: "Bedroom" },
        { segmentId: 18, mapId: 0, name: "Hall" },
      ],
    });
    vacuum.dispose();

    expect(
      accessory.clusters.serviceArea.supportedAreas.map(
        (area) => area.areaInfo.locationInfo.locationName
      )
    ).toEqual(["Bedroom", "Bedroom 2", "Hall"]);
  });
});
