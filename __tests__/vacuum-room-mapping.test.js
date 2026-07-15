const { vacuum } = require("../roborockLib/lib/vacuum");

function createAdapter(mappedRooms, multiMapResponse = []) {
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    messageQueueHandler: {
      sendRequest: jest.fn((duid, method) => {
        if (method === "get_prop") {
          return Promise.resolve([{ state: 8, battery: 100 }]);
        }
        if (method === "get_status") {
          return Promise.resolve([{ map_status: 8 }]);
        }
        if (method === "get_room_mapping") {
          return Promise.resolve(mappedRooms);
        }
        if (method === "get_multi_maps_list") {
          return Promise.resolve(multiMapResponse);
        }
        return Promise.resolve([]);
      }),
    },
    config: { updateInterval: 60 },
    socket: null,
    getObjectAsync: jest.fn().mockResolvedValue({}),
    roomIDs: {},
    isCleaning: jest.fn().mockReturnValue(false),
    startMapUpdater: jest.fn(),
    stopMapUpdater: jest.fn(),
    manageDeviceIntervals: jest.fn(),
    updateRoomMappingCache: jest.fn(),
    updateMapListCache: jest.fn(),
    createStateObjectHelper: jest.fn().mockResolvedValue(undefined),
    setStateAsync: jest.fn().mockResolvedValue(undefined),
    setStateChangedAsync: jest.fn().mockResolvedValue(undefined),
    setObjectAsync: jest.fn().mockResolvedValue(undefined),
    delObjectAsync: jest.fn().mockResolvedValue(undefined),
    vacuums: {
      "device-1": {
        features: {
          getConsumablesDivider: jest.fn(),
          getStatusDivider: jest.fn(),
          hasDeviceStatusAttribute: jest.fn((attribute) =>
            ["state", "battery", "map_status"].includes(attribute)
          ),
          processDockType: jest.fn(),
          getFirmwareFeature: jest.fn(),
        },
      },
    },
  };
}

describe("vacuum room mapping", () => {
  test("creates fallback room names when HomeData is missing room labels", async () => {
    const adapter = createAdapter([[101, 55]]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_room_mapping");

    expect(adapter.createStateObjectHelper).toHaveBeenCalledWith(
      "Devices.device-1.floors.2.101",
      "Room 55",
      "boolean",
      null,
      true,
      "value",
      true,
      true
    );
    expect(adapter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Using fallback labels")
    );
  });

  test("logs an info message instead of warning when no room mappings are returned", async () => {
    const adapter = createAdapter([]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_room_mapping");

    expect(adapter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("No room mappings returned")
    );
    expect(adapter.log.warn).not.toHaveBeenCalled();
  });

  test("updates the shared room mapping cache after reading room mappings", async () => {
    const adapter = createAdapter([[101, 55]]);
    adapter.roomIDs = { 55: "Kitchen" };
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_room_mapping");

    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith("device-1", 2, [
      [101, 55],
    ]);
  });

  test("updates the shared map list cache after reading multi-map metadata", async () => {
    const mapInfo = [
      { mapFlag: 0, name: "Lower Level" },
      { mapFlag: 1, name: "Upper Level" },
    ];
    const adapter = createAdapter(
      [],
      [{ max_multi_map: 2, multi_map_count: 2, map_info: mapInfo }]
    );
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_multi_maps_list");

    expect(adapter.updateMapListCache).toHaveBeenCalledWith(
      "device-1",
      mapInfo
    );
    expect(adapter.createStateObjectHelper).toHaveBeenCalledWith(
      "Devices.device-1.commands.load_multi_map",
      "Load map",
      "number",
      null,
      0,
      "value",
      true,
      true,
      { 0: "Lower Level", 1: "Upper Level" }
    );
  });

  test("sends direct room segment clean commands for Matter service areas", async () => {
    const adapter = createAdapter([]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.command("device-1", "app_segment_clean_by_ids", {
      segments: [101, "102", 101, "bad"],
      repeat: 2,
    });

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "device-1",
      "app_segment_clean",
      [{ segments: [101, 102], repeat: 2 }]
    );
  });

  test("loads a multi-map before refreshing room mappings", async () => {
    const adapter = createAdapter([[101, 55]]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.command("device-1", "load_multi_map", 2);

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "device-1",
      "load_multi_map",
      [2]
    );
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith("device-1", 2, [
      [101, 55],
    ]);
  });

  test("uses cloud preference for forced status refreshes when requested", async () => {
    const adapter = createAdapter([]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_status", "force", {
      preferCloud: true,
    });

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "device-1",
      "get_prop",
      ["get_status"],
      false,
      false,
      { preferCloud: true }
    );
  });

  test("keeps known get_status fields quiet when their Homebridge object is missing", async () => {
    const adapter = createAdapter([]);
    adapter.getObjectAsync.mockResolvedValue(null);
    adapter.messageQueueHandler.sendRequest.mockImplementation(
      (duid, method) => {
        if (method === "get_prop") {
          return Promise.resolve([
            { state: 8, battery: 100, unexpected_status: "new-value" },
          ]);
        }
        return Promise.resolve([]);
      }
    );
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_status", "force");

    expect(adapter.log.warn).toHaveBeenCalledTimes(1);
    expect(adapter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("unexpected_status")
    );
    expect(adapter.log.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipping known get_status attribute without a Homebridge state object: state"
      )
    );
    expect(adapter.log.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipping known get_status attribute without a Homebridge state object: battery"
      )
    );
  });
});
