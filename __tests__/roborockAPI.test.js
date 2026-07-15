const { Roborock } = require("../roborockLib/roborockAPI");
const fs = require("fs");
const os = require("os");
const path = require("path");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock(options = {}) {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-api-test-")),
    ...options,
  });
}

describe("Roborock API model and diagnostics helpers", () => {
  test("prefers device-level model metadata when product metadata is incomplete", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            productModel: "roborock.vacuum.a08",
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getProductAttribute("device-1", "model")).toBe(
      "roborock.vacuum.a08"
    );
  });

  test("getVacuumList merges owned and received devices", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [{ duid: "owned-device" }],
        receivedDevices: [{ duid: "shared-device" }],
      }),
      ack: true,
    });

    expect(api.getVacuumList().map((device) => device.duid)).toEqual([
      "owned-device",
      "shared-device",
    ]);
  });

  test("getStatus can force an immediate status poll", async () => {
    const api = createRoborock();
    const getParameter = jest.fn().mockResolvedValue(undefined);
    api.vacuums = {
      "device-1": { getParameter },
    };

    await api.getStatus("device-1", { force: true });

    expect(getParameter).toHaveBeenCalledWith(
      "device-1",
      "get_status",
      "force"
    );
  });

  test("getStatus passes cloud preference to the vacuum status poll", async () => {
    const api = createRoborock();
    const getParameter = jest.fn().mockResolvedValue(undefined);
    api.vacuums = {
      "device-1": { getParameter },
    };

    await api.getStatus("device-1", { force: true, preferCloud: true });

    expect(getParameter).toHaveBeenCalledWith(
      "device-1",
      "get_status",
      "force",
      { preferCloud: true }
    );
  });

  test("stores room mapping cache for Matter service areas", () => {
    const api = createRoborock();
    const notify = jest.fn();
    api.roomIDs = { 55: "Kitchen" };
    api.setDeviceNotify(notify);

    api.updateRoomMappingCache("device-1", 2, [
      [101, 55],
      [101, 56],
      ["bad", 57],
      [102, 99],
    ]);

    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 101, roomId: 55, mapId: 2, name: "Kitchen" },
      { segmentId: 102, roomId: 99, mapId: 2, name: "Room 99" },
    ]);
    expect(notify).toHaveBeenCalledWith(
      "RoomMapping",
      expect.objectContaining({
        duid: "device-1",
        mapId: 2,
      })
    );
  });

  test("keeps Matter room mappings for multiple Roborock maps", () => {
    const api = createRoborock();
    api.roomIDs = {
      55: "Kitchen",
      77: "Bedroom",
    };

    api.updateMapListCache("device-1", [
      { mapFlag: 0, name: "Lower Level" },
      { mapFlag: 1, name: "Upper Level" },
    ]);
    api.updateRoomMappingCache("device-1", 0, [[16, 55]]);
    api.updateRoomMappingCache("device-1", 1, [[16, 77]]);

    expect(api.getMapListForDevice("device-1")).toEqual([
      { mapId: 0, name: "Lower Level" },
      { mapId: 1, name: "Upper Level" },
    ]);
    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 16, roomId: 55, mapId: 0, name: "Kitchen" },
      { segmentId: 16, roomId: 77, mapId: 1, name: "Bedroom" },
    ]);
    expect(api.getCurrentMapIdForDevice("device-1")).toBe(1);
  });

  test("Matter Service Area caches rooms from missing saved maps while idle", async () => {
    const api = createRoborock({ enableMatterServiceArea: true });
    api.roomIDs = {
      55: "Lower Level",
      77: "Upper Hallway",
    };
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1", model: "roborock.vacuum.a08" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { state: "8" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const mapInfo = [
      { mapFlag: 0, name: "Lower Floor" },
      { mapFlag: 1, name: "Upper Floor" },
    ];
    const robot = {
      getParameter: jest.fn(async (duid, parameter) => {
        if (parameter === "get_multi_maps_list") {
          api.updateMapListCache(duid, mapInfo);
          return mapInfo;
        }

        if (parameter === "get_room_mapping") {
          api.updateRoomMappingCache(duid, 0, [[16, 55]]);
          return [[16, 55]];
        }

        return null;
      }),
      command: jest.fn(async (duid, parameter, mapId) => {
        if (parameter !== "load_multi_map") {
          return;
        }

        if (mapId === 1) {
          api.updateRoomMappingCache(duid, 1, [[17, 77]]);
        } else {
          api.updateRoomMappingCache(duid, 0, [[16, 55]]);
        }
      }),
    };

    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");

    expect(robot.command).toHaveBeenCalledWith(
      "device-1",
      "load_multi_map",
      1,
      {
        throwOnError: true,
      }
    );
    expect(robot.command).toHaveBeenCalledWith(
      "device-1",
      "load_multi_map",
      0,
      {
        throwOnError: true,
      }
    );
    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 16, roomId: 55, mapId: 0, name: "Lower Level" },
      { segmentId: 17, roomId: 77, mapId: 1, name: "Upper Hallway" },
    ]);
  });

  test("Matter Service Area does not reload the active map when its rooms are missing", async () => {
    const api = createRoborock({ enableMatterServiceArea: true });
    api.roomIDs = {
      55: "Lower Level",
      77: "Upper Hallway",
    };
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1", model: "roborock.vacuum.a08" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { state: "8" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const mapInfo = [
      { mapFlag: 0, name: "Lower Floor" },
      { mapFlag: 1, name: "Upper Floor" },
    ];
    api.updateMapListCache("device-1", mapInfo);
    api.updateRoomMappingCache("device-1", 0, [[16, 55]]);

    const robot = {
      getParameter: jest.fn(async (duid, parameter) => {
        if (parameter === "get_multi_maps_list") {
          api.updateMapListCache(duid, mapInfo);
          return mapInfo;
        }

        if (parameter === "get_room_mapping") {
          api.updateRoomMappingCache(duid, 1, []);
          return [];
        }

        return null;
      }),
      command: jest.fn(),
    };

    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");

    expect(robot.command).not.toHaveBeenCalled();
    expect(
      robot.getParameter.mock.calls.filter(
        ([, parameter]) => parameter === "get_room_mapping"
      )
    ).toHaveLength(2);
    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 16, roomId: 55, mapId: 0, name: "Lower Level" },
    ]);
  });

  test("Matter Service Area restores the original map when a saved map load times out", async () => {
    const api = createRoborock({ enableMatterServiceArea: true });
    api.roomIDs = { 55: "Lower Level" };
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1", model: "roborock.vacuum.a08" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { state: "8" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const mapInfo = [
      { mapFlag: 0, name: "Lower Level" },
      { mapFlag: 1, name: "Upper Level" },
    ];

    const robot = {
      getParameter: jest.fn(async (duid, parameter) => {
        if (parameter === "get_multi_maps_list") {
          api.updateMapListCache(duid, mapInfo);
          return mapInfo;
        }
        if (parameter === "get_room_mapping") {
          api.updateRoomMappingCache(duid, 0, [[16, 55]]);
          return [[16, 55]];
        }
        return null;
      }),
      command: jest.fn(async (duid, parameter, mapId) => {
        if (parameter !== "load_multi_map") {
          return;
        }
        if (mapId === 1) {
          // The robot switches to the saved map but the ack times out, exactly
          // like the slow S6 Pure in the field logs.
          api.updateRoomMappingCache(duid, 1, []);
          throw new Error(
            "Local request with id 6 with method load_multi_map timed out after 10 seconds"
          );
        }
        // Restoring the original map succeeds.
        api.updateRoomMappingCache(duid, 0, [[16, 55]]);
      }),
    };

    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");

    const loadCalls = robot.command.mock.calls.filter(
      ([, parameter]) => parameter === "load_multi_map"
    );
    // Attempted the missing map, then restored the original map despite the
    // timeout so the robot is not left on the wrong saved map.
    expect(loadCalls.map(([, , mapId]) => mapId)).toEqual([1, 0]);
    expect(api.getCurrentMapIdForDevice("device-1")).toBe(0);
  });

  test("Matter Service Area retries an empty saved map only after the refresh TTL", async () => {
    let now = 1_000_000;
    const api = createRoborock({
      enableMatterServiceArea: true,
      now: () => now,
    });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1", model: "roborock.vacuum.a08" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { state: "8" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const mapInfo = [
      { mapFlag: 0, name: "Lower Level" },
      { mapFlag: 1, name: "Upper Level" },
    ];
    const robot = {
      getParameter: jest.fn(async (duid, parameter) => {
        if (parameter === "get_multi_maps_list") {
          api.updateMapListCache(duid, mapInfo);
          return mapInfo;
        }
        if (parameter === "get_room_mapping") {
          api.updateRoomMappingCache(duid, 0, [[16, 55]]);
          return [[16, 55]];
        }
        return null;
      }),
      // Upper Level keeps reporting no rooms; it switches the active map.
      command: jest.fn(async (duid, parameter, mapId) => {
        if (parameter === "load_multi_map") {
          api.updateRoomMappingCache(
            duid,
            mapId,
            mapId === 0 ? [[16, 55]] : []
          );
        }
      }),
    };

    const countUpperLoads = () =>
      robot.command.mock.calls.filter(
        ([, parameter, mapId]) => parameter === "load_multi_map" && mapId === 1
      ).length;

    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");
    expect(countUpperLoads()).toBe(1);

    // Within the TTL the still-empty map is not re-attempted.
    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");
    expect(countUpperLoads()).toBe(1);

    // After the TTL elapses it is retried.
    now += 6 * 60 * 60 * 1000 + 1;
    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");
    expect(countUpperLoads()).toBe(2);
  });

  test("detects Matter mop clean mode support from schema capabilities", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { fan_power: "104" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getMatterCleanModeCapabilities("device-1")).toEqual({
      canVacuum: true,
      canMop: true,
      canControlFanPower: true,
      canControlWater: true,
    });
    expect(api.getVacuumDeviceStatus("device-1", "fan_power")).toBe("104");
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([
      "set_water_box_mode",
      "set_water_box_custom_mode",
    ]);
  });

  test("does not expose Matter mop clean modes for vacuum-only schemas", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [{ id: 123, code: "fan_power" }],
          },
        ],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getMatterCleanModeCapabilities("device-1")).toMatchObject({
      canMop: false,
      canControlFanPower: true,
      canControlWater: false,
    });
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([]);
  });

  test("applies Matter clean mode settings through Roborock setting commands", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(),
    };

    await api.applyMatterCleanModeSettings(
      "device-1",
      {
        fanPower: 105,
        waterBoxMode: 201,
      },
      { waitForResult: true }
    );

    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_custom_mode",
      105,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_mode",
      201,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
  });

  test("falls back between Roborock water mode commands for Matter clean modes", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [{ duid: "device-1", productId: "product-1" }],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(async (duid, command) => {
        if (command === "set_water_box_mode") {
          throw new Error("unknown method");
        }
      }),
    };

    await api.applyMatterCleanModeSettings(
      "device-1",
      { waterBoxMode: 201 },
      { waitForResult: true }
    );

    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_custom_mode",
      201,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([
      "set_water_box_custom_mode",
    ]);
  });

  test("does not block Matter clean mode when water commands return unsupported results", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [{ duid: "device-1", productId: "product-1" }],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(async (duid, command) => {
        if (
          command === "set_water_box_mode" ||
          command === "set_water_box_custom_mode"
        ) {
          return "unknown_method";
        }
        return ["ok"];
      }),
    };

    await expect(
      api.applyMatterCleanModeSettings(
        "device-1",
        { fanPower: 104, waterBoxMode: 200 },
        { waitForResult: true }
      )
    ).resolves.toBeUndefined();

    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_custom_mode",
      104,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_mode",
      200,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_custom_mode",
      200,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("continuing with start command")
    );
  });

  test("skips remaining Matter clean mode prep when fan command times out", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [{ duid: "device-1", productId: "product-1" }],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(async () => {
        throw new Error(
          "Cloud request with id 47 with method set_custom_mode timed out after 2 seconds. MQTT connection state: true"
        );
      }),
    };

    await api.applyMatterCleanModeSettings(
      "device-1",
      { fanPower: 104, waterBoxMode: 200 },
      { waitForResult: true }
    );

    expect(api.vacuums["device-1"].command).toHaveBeenCalledTimes(1);
    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_custom_mode",
      104,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("skipping remaining clean-mode prep")
    );
  });

  test("does not fall back between Roborock water commands after a timeout", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [{ duid: "device-1", productId: "product-1" }],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(async () => {
        throw new Error(
          "Cloud request with id 48 with method set_water_box_mode timed out after 2 seconds. MQTT connection state: true"
        );
      }),
    };

    await api.applyMatterCleanModeSettings(
      "device-1",
      { waterBoxMode: 200 },
      { waitForResult: true }
    );

    expect(api.vacuums["device-1"].command).toHaveBeenCalledTimes(1);
    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_mode",
      200,
      { waitForResult: true, requestTimeoutMs: 2000, throwOnError: true }
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("not trying fallback commands before start")
    );
  });

  test("transport diagnostics are persisted per device", async () => {
    const api = createRoborock();

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      tcpConnectionState: "connected",
    });

    expect(api.getTransportDiagnostics()).toEqual({
      "device-1": expect.objectContaining({
        lastTransport: "local",
        tcpConnectionState: "connected",
      }),
    });
  });

  test("refreshes rotated Roborock local keys and resets the local TCP client", async () => {
    const api = createRoborock();
    api.localKeys = new Map([["device-1", "old-local-key"]]);
    api.localDevices = { "device-1": "192.168.1.12" };
    api.localConnector.resetClient = jest.fn().mockResolvedValue(undefined);
    api.localConnector.createClient = jest.fn().mockResolvedValue(undefined);

    await api.refreshLocalKeysFromHomeData({
      devices: [
        {
          duid: "device-1",
          name: "Roborock",
          localKey: "new-local-key",
        },
      ],
      receivedDevices: [],
    });

    expect(api.localKeys.get("device-1")).toBe("new-local-key");
    expect(api.localConnector.resetClient).toHaveBeenCalledWith(
      "device-1",
      "local-key-changed"
    );
    expect(api.localConnector.createClient).toHaveBeenCalledWith(
      "device-1",
      "192.168.1.12"
    );
  });

  test("Roborock diagnostics are compacted and persisted per device", async () => {
    const api = createRoborock();

    await api.updateRoborockDiagnostics("device-1", "lastTimer", {
      localKey: "secret-local-key",
      schedules: [{ id: 1, enabled: true, cron: "0 7 * * *" }],
    });

    expect(api.getRoborockDiagnostics()).toEqual({
      "device-1": expect.objectContaining({
        lastTimer: {
          localKey: "[redacted]",
          schedules: [{ id: 1, enabled: true, cron: "0 7 * * *" }],
        },
      }),
    });
  });

  test("records scoped live Roborock messages in diagnostics", () => {
    const api = createRoborock();

    api.recordRoborockDiagnosticMessage("CloudMessage", {
      duid: "device-1",
      payload: [{ state: 18, in_cleaning: 3, map_status: 7 }],
    });

    expect(api.getRoborockDiagnostics()).toEqual({
      "device-1": expect.objectContaining({
        lastCloudMessage: expect.objectContaining({
          source: "CloudMessage",
          payload: [{ state: 18, in_cleaning: 3, map_status: 7 }],
        }),
      }),
    });
  });

  test("caches persisted state in memory after the first disk read", () => {
    const api = createRoborock();
    const persistPath = api.getPersistPath("HomeData");
    const original = {
      val: JSON.stringify({ devices: [{ duid: "device-1" }] }),
      ack: true,
    };
    fs.writeFileSync(persistPath, JSON.stringify(original));

    // The first read loads and parses the persisted file from disk.
    expect(api.getStateAsync("HomeData")).toEqual(original);

    // A later external change to the file is intentionally not observed because
    // the parsed value is now served from the in-memory cache.
    fs.writeFileSync(
      persistPath,
      JSON.stringify({ val: "changed", ack: true })
    );
    expect(api.getStateAsync("HomeData")).toEqual(original);
  });

  test("keeps the in-memory cache in sync with writes and deletes", async () => {
    const api = createRoborock();

    await api.setStateAsync("TransportDiagnostics", { val: "x", ack: true });
    // Served from the cache that setStateAsync populated, without a disk read.
    expect(api.getStateAsync("TransportDiagnostics")).toEqual({
      val: "x",
      ack: true,
    });

    await api.deleteStateAsync("TransportDiagnostics");
    // Deleting persisted state clears the cache entry so the next read reflects
    // the removed file instead of returning a stale cached value.
    expect(api.getStateAsync("TransportDiagnostics")).toBeNull();
  });

  test("transport diagnostics debug-log cloud fallback and local recovery", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [{ duid: "device-1", name: "Hallway Robot" }],
        receivedDevices: [],
      }),
      ack: true,
    });

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_status",
    });
    log.debug.mockClear();

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "cloud",
      lastTransportReason: "local-unavailable-fallback",
      lastCommandMethod: "get_consumable",
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Falling back from local LAN to Roborock cloud")
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "the local TCP socket was not connected when the command was requested"
      )
    );

    log.debug.mockClear();
    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_consumable",
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Local transport recovered")
    );
  });

  test("transport diagnostics do not log when only the command method changes", async () => {
    const log = createLog();
    const api = createRoborock({ log });

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_status",
    });
    log.debug.mockClear();

    await api.updateTransportDiagnostics("device-1", {
      lastCommandMethod: "get_consumable",
    });

    expect(log.debug).not.toHaveBeenCalled();
  });

  test("cloud-only transport reasons are not described as fallback", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [{ duid: "device-1", name: "Hallway Robot" }],
        receivedDevices: [],
      }),
      ack: true,
    });

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_status",
    });
    log.debug.mockClear();

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "cloud",
      lastTransportReason: "cloud-only-mode",
      lastCommandMethod: "get_network_info",
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Using Roborock cloud transport")
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("cloud-only mode is enabled")
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("Falling back")
    );
  });

  test("transient command warnings are throttled per robot", async () => {
    const log = createLog();
    let now = 1000;
    const api = createRoborock({
      log,
      errorLogThrottleMs: 60 * 1000,
      now: () => now,
    });

    await api.catchError(
      new Error(
        "Local request with id 149 with method get_consumable timed out after 10 seconds Local connect state: true"
      ),
      "get_consumable",
      "device-1",
      "roborock.vacuum.a51"
    );
    await api.catchError(
      new Error(
        "Local request with id 150 with method get_carpet_mode timed out after 10 seconds Local connect state: true"
      ),
      "get_carpet_mode",
      "device-1",
      "roborock.vacuum.a51"
    );
    await api.catchError(
      new Error(
        "Local request with id 151 with method get_water_box_custom_mode timed out after 10 seconds Local connect state: true"
      ),
      "get_water_box_custom_mode",
      "device-1",
      "roborock.vacuum.a51"
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Suppressed transient local timeout warning")
    );

    now += 60 * 1000 + 1;
    await api.catchError(
      new Error(
        "Local request with id 152 with method get_status timed out after 10 seconds Local connect state: true"
      ),
      "get_room_mapping",
      "device-1",
      "roborock.vacuum.a51"
    );

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toContain(
      "2 similar warning(s) across get_carpet_mode (1), get_water_box_custom_mode (1) were suppressed"
    );
    expect(log.warn.mock.calls[1][0]).toContain(
      "Future transient local timeout warnings for this robot"
    );
  });

  test("classifies command timeouts regardless of the configured duration", () => {
    const api = createRoborock();

    expect(
      api.getTransientErrorKind(
        "Local request with id 6 with method load_multi_map timed out after 30 seconds Local connect state: true"
      )
    ).toBe("local timeout");
    expect(
      api.getTransientErrorKind(
        "Cloud request with id 7 with method get_status timed out after 10 seconds. MQTT connection state: true"
      )
    ).toBe("cloud timeout");
  });

  test("zero transient warning throttle moves transient warnings to debug only", async () => {
    const log = createLog();
    const api = createRoborock({
      log,
      errorLogThrottleMs: 0,
    });

    await api.catchError(
      new Error(
        "Local request with id 149 with method get_consumable timed out after 10 seconds Local connect state: true"
      ),
      "get_consumable",
      "device-1",
      "roborock.vacuum.a51"
    );

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Suppressed transient local timeout warning")
    );
  });

  test("skip device helper matches serial numbers and DUIDs", () => {
    const api = createRoborock();
    const ignoredSet = new Set(api.parseSkipDevices("serial-1, duid-2"));

    expect(
      api.shouldSkipDevice({ sn: "serial-1", duid: "duid-1" }, ignoredSet)
    ).toBe(true);
    expect(
      api.shouldSkipDevice({ sn: "serial-2", duid: "duid-2" }, ignoredSet)
    ).toBe(true);
    expect(
      api.shouldSkipDevice({ sn: "serial-3", duid: "duid-3" }, ignoredSet)
    ).toBe(false);
  });
});
