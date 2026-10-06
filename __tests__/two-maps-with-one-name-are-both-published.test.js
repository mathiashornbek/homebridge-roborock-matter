"use strict";

/**
 * Review: withUniqueLocationNames() closes the duplicate-ROOM-name refusal,
 * but its twin on supportedMaps is still open. ServiceAreaServer
 * #assertSupportedMaps (0.17.9) throws `MapName "…" is not unique`, which
 * fails registration ("Behaviors have errors") or refuses every later
 * serviceArea write whole — the same failure the room fix exists for.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

test("two Roborock maps with the same name", async () => {
  const platform = {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    platformConfig: { enableMatter: true },
    getMatterApi: () => ({ updateAccessoryState: jest.fn() }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "S8" : "",
      getProductAttribute: () => "roborock.vacuum.a51",
      getVacuumDeviceStatus: (duid, property) =>
        ({ state: 8, battery: 100, charge_status: 1, error_code: 0 })[
          property
        ] ?? "",
      getRoomMappingsForDevice: () => [
        { segmentId: 16, mapId: 0, name: "Kitchen" },
        { segmentId: 16, mapId: 1, name: "Bedroom" },
      ],
      // Two floors the user named the same in the Roborock app.
      getMapListForDevice: () => [
        { mapId: 0, name: "Home" },
        { mapId: 1, name: "Home" },
      ],
      getCurrentMapIdForDevice: () => 0,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
  const accessory = { UUID: "uuid-maps", context: { duid: "device-maps" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-maps" },
    true
  );
  vacuum.dispose();

  // Replay the registration-time cluster through the 0.17.9 validators.
  const store = createMatterStore({ serviceArea: { supportedAreas: [] } });
  await store.updateAccessoryState("uuid-maps", "serviceArea", {
    supportedMaps: accessory.clusters.serviceArea.supportedMaps,
    supportedAreas: accessory.clusters.serviceArea.supportedAreas,
  });

  expect(store.rejected.map((r) => r.error)).toEqual([]);
});
