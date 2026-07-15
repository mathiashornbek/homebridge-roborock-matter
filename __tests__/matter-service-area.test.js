const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

function createPlatform({ rooms = [], maps = [] } = {}) {
  return {
    platformConfig: {
      enableMatter: true,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => null,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) => {
        if (property === "name") {
          return "Test Vacuum";
        }
        return "";
      },
      getProductAttribute: () => "roborock.vacuum.a08",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => rooms.map((room) => ({ ...room })),
      getMapListForDevice: () => maps.map((map) => ({ ...map })),
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: false,
      }),
    },
  };
}

function buildServiceAreaCluster(options) {
  const platform = createPlatform(options);
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  // Constructing the accessory builds the Matter clusters from the mocked
  // Roborock data via updateMetadata().
  new RoborockMatterVacuumAccessory(platform, accessory, { duid: "device-1" });
  return accessory.clusters.serviceArea;
}

describe("Matter Service Area map/area metadata", () => {
  test("every non-null area mapId has a matching supportedMaps entry", () => {
    // Roborock only reports a name for map 0, but rooms exist on maps 0 and 5.
    const cluster = buildServiceAreaCluster({
      rooms: [
        { segmentId: 16, mapId: 0, name: "Kitchen" },
        { segmentId: 17, mapId: 5, name: "Attic" },
      ],
      maps: [{ mapId: 0, name: "Lower Floor" }],
    });

    const mapIds = cluster.supportedMaps.map((map) => map.mapId);
    for (const area of cluster.supportedAreas) {
      if (area.mapId !== null) {
        expect(mapIds).toContain(area.mapId);
      }
    }

    // The map without a Roborock name still gets a generated fallback label.
    expect(cluster.supportedMaps).toEqual(
      expect.arrayContaining([
        { mapId: 0, name: "Lower Floor" },
        { mapId: 5, name: "Roborock Map 5" },
      ])
    );
  });

  test("does not advertise saved maps that have no resolved rooms", () => {
    const cluster = buildServiceAreaCluster({
      rooms: [{ segmentId: 16, mapId: 0, name: "Kitchen" }],
      maps: [
        { mapId: 0, name: "Lower Floor" },
        { mapId: 1, name: "Upper Floor" },
      ],
    });

    const mapIds = cluster.supportedMaps.map((map) => map.mapId);
    expect(mapIds).toEqual([0]);

    // supportedMaps never advertises a map that has no matching area.
    const areaMapIds = new Set(
      cluster.supportedAreas
        .map((area) => area.mapId)
        .filter((mapId) => mapId !== null)
    );
    for (const map of cluster.supportedMaps) {
      expect(areaMapIds.has(map.mapId)).toBe(true);
    }
  });

  test("prefers Roborock map names over generated labels", () => {
    const cluster = buildServiceAreaCluster({
      rooms: [
        { segmentId: 16, mapId: 0, name: "Kitchen" },
        { segmentId: 17, mapId: 1, name: "Bedroom" },
      ],
      maps: [
        { mapId: 0, name: "Lower Floor" },
        { mapId: 1, name: "Upper Floor" },
      ],
    });

    expect(cluster.supportedMaps).toEqual([
      { mapId: 0, name: "Lower Floor" },
      { mapId: 1, name: "Upper Floor" },
    ]);
  });
});
