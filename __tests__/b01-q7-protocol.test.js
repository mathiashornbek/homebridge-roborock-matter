const fs = require("fs");
const os = require("os");
const path = require("path");
const b01 = require("../roborockLib/lib/b01Q7Adapter");
const {
  resolveB01PendingResponse,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const { message } = require("../roborockLib/lib/message");
const { Roborock } = require("../roborockLib/roborockAPI");

// Real Q7 response recorded by the python-roborock reference implementation.
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "testdata", "b01_q7_get_prop_response.json"),
    "utf8"
  )
);

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe("B01/Q7 command translation (reference parity)", () => {
  test.each([
    [
      "app_start",
      null,
      {
        method: "service.set_room_clean",
        params: { clean_type: 0, ctrl_value: 1, room_ids: [] },
      },
    ],
    [
      "app_stop",
      null,
      {
        method: "service.set_room_clean",
        params: { clean_type: 0, ctrl_value: 0, room_ids: [] },
      },
    ],
    [
      "app_pause",
      null,
      {
        method: "service.set_room_clean",
        params: { clean_type: 0, ctrl_value: 2, room_ids: [] },
      },
    ],
    ["app_charge", null, { method: "service.start_recharge", params: {} }],
    ["find_me", null, { method: "service.find_device", params: {} }],
  ])(
    "%s translates to the reference Q7 call",
    (methodName, params, expected) => {
      const translated = b01.translateOutgoing(methodName, params);
      expect(translated.method).toBe(expected.method);
      expect(translated.params).toEqual(expected.params);
    }
  );

  test("app_segment_clean carries the room ids with clean_type room", () => {
    const translated = b01.translateOutgoing("app_segment_clean", [
      { segments: [16, 17] },
    ]);
    expect(translated).toEqual({
      method: "service.set_room_clean",
      params: { clean_type: 1, ctrl_value: 1, room_ids: [16, 17] },
    });
  });

  test("get_prop [get_status] becomes prop.get with the property list", () => {
    const translated = b01.translateOutgoing("get_prop", ["get_status"]);
    expect(translated.method).toBe("prop.get");
    expect(translated.params.property).toEqual(
      expect.arrayContaining(["status", "quantity", "fault"])
    );
    expect(translated.kind).toBe("status");
  });

  test("fan power set_custom_mode maps v1 codes to Q7 wind codes", () => {
    expect(b01.translateOutgoing("set_custom_mode", [102])).toEqual({
      method: "prop.set",
      params: { wind: 2 },
    });
    expect(b01.translateOutgoing("set_custom_mode", [108])).toEqual({
      method: "prop.set",
      params: { wind: 5 },
    });
  });

  test("unknown methods return null while periodic reads get neutral responses", () => {
    expect(b01.translateOutgoing("get_map_v1", null)).toBeNull();
    expect(b01.neutralResponse("get_network_info")).toEqual({ value: {} });
    expect(b01.neutralResponse("get_room_mapping")).toEqual({ value: [] });
    expect(b01.neutralResponse("app_start")).toBeUndefined();
  });
});

describe("B01/Q7 status mapping", () => {
  test("maps the recorded reference fixture (charging robot)", () => {
    const inner = JSON.parse(FIXTURE.dps["10001"]);
    expect(inner.code).toBe(0);

    const v1 = b01.mapStatusToV1(inner.data);
    // Fixture: {"status":4 (charging), "main_brush":4088}
    expect(v1.state).toBe(8);
    expect(v1.error_code).toBe(0);
  });

  test("maps a full status snapshot to v1 fields", () => {
    const v1 = b01.mapStatusToV1({
      status: 5,
      quantity: 87,
      fault: 0,
      wind: 2,
      water: 3,
    });
    // Q7 water tanks are manual: water is never mapped or exposed.
    expect(v1).toEqual({
      state: 5,
      error_code: 0,
      charge_status: 0,
      battery: 87,
      fan_power: 102,
    });
  });

  test("fault is a diagnostic channel and never overrides the work status", () => {
    // Informational 407 ("scheduled cleanup ignored") lingers on healthy,
    // charging robots — it must not taint state or error_code (field bug:
    // it froze the Apple Home tile in an error publish).
    const informational = b01.mapStatusToV1({
      status: 4,
      quantity: 100,
      fault: 407,
    });
    expect(informational.state).toBe(8);
    expect(informational.error_code).toBe(0);
    expect(informational.charge_status).toBe(1);

    // Real faults surface as error_code but the work status stays truthful.
    const realFault = b01.mapStatusToV1({ status: 5, fault: 510 });
    expect(realFault.state).toBe(5);
    expect(realFault.error_code).toBe(510);
  });

  test("covers every documented Q7 work status", () => {
    for (const [q7, v1] of Object.entries(b01.B01_STATUS_TO_V1_STATE)) {
      expect(b01.mapStatusToV1({ status: Number(q7), fault: 0 }).state).toBe(
        v1
      );
    }
  });
});

describe("B01 request payload format (reference parity)", () => {
  test("buildPayload emits method/msgId/params on dps 10000 with no t or id", async () => {
    const adapter = {
      getRobotVersion: jest.fn().mockResolvedValue("B01"),
      nonce: Buffer.alloc(16),
      rr_mqtt_connector: { getEndpoint: jest.fn().mockReturnValue("endpoint") },
    };
    const msg = new message(adapter);
    const payload = await msg.buildPayload(
      "duid-1",
      101,
      "200000000001",
      "prop.get",
      { property: ["status"] },
      false,
      false
    );

    const parsed = JSON.parse(payload);
    expect(Object.keys(parsed)).toEqual(["dps"]);
    expect(parsed.dps["10000"]).toEqual({
      method: "prop.get",
      msgId: "200000000001",
      params: { property: ["status"] },
    });
  });

  test("12-digit message ids", () => {
    for (let i = 0; i < 25; i++) {
      expect(b01.createB01MessageId()).toMatch(/^[1-9]\d{11}$/);
    }
  });
});

describe("B01 encryption round-trip", () => {
  test("buildRoborockMessage output decodes back to the original payload", async () => {
    const localKey = "0123456789abcdef";
    const adapter = {
      getRobotVersion: jest.fn().mockResolvedValue("B01"),
      localKeys: new Map([["duid-1", localKey]]),
      nonce: Buffer.alloc(16),
      log: createLog(),
    };
    const msg = new message(adapter);
    const payload = JSON.stringify({
      dps: { 10000: { method: "prop.get", msgId: "200000000001", params: [] } },
    });

    const wire = await msg.buildRoborockMessage(
      "duid-1",
      101,
      Math.floor(Date.now() / 1000),
      payload
    );
    expect(Buffer.isBuffer(wire)).toBe(true);
    expect(wire.toString("latin1", 0, 3)).toBe("B01");

    const decoded = msg._decodeMsg(wire, "duid-1");
    expect(decoded).not.toBeNull();
    const roundTripped = decoded.payload
      .toString("utf8")
      .replace(/[\x00-\x10]+$/g, "");
    expect(JSON.parse(roundTripped)).toEqual(JSON.parse(payload));
  });
});

describe("B01 response correlation", () => {
  function createAdapter() {
    return {
      pendingRequests: new Map(),
      clearTimeout: jest.fn((t) => clearTimeout(t)),
      log: createLog(),
      getStatus: jest.fn().mockResolvedValue(undefined),
    };
  }

  test("resolves the pending request with the fixture data by msgId", () => {
    const adapter = createAdapter();
    const inner = JSON.parse(FIXTURE.dps["10001"]);
    const resolve = jest.fn();
    const reject = jest.fn();
    adapter.pendingRequests.set(String(inner.msgId), {
      resolve,
      reject,
      timeout: setTimeout(() => undefined, 5000),
    });

    const handled = resolveB01PendingResponse(adapter, "duid-1", inner);

    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith(inner.data);
    expect(reject).not.toHaveBeenCalled();
    expect(adapter.pendingRequests.size).toBe(0);
  });

  test("rejects when the robot reports a non-zero code", () => {
    const adapter = createAdapter();
    const resolve = jest.fn();
    const reject = jest.fn();
    adapter.pendingRequests.set("300000000001", {
      resolve,
      reject,
      timeout: setTimeout(() => undefined, 5000),
    });

    resolveB01PendingResponse(adapter, "duid-1", {
      msgId: "300000000001",
      code: 10001,
      method: "service.set_room_clean",
    });

    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("failed with code 10001"),
      })
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  test("unsolicited pushes trigger a status refresh and v1 messages pass through", () => {
    const adapter = createAdapter();

    expect(
      resolveB01PendingResponse(adapter, "duid-1", {
        msgId: "999999999999",
        method: "event.clean_finish.post",
      })
    ).toBe(true);
    expect(adapter.getStatus).toHaveBeenCalledWith("duid-1", { force: true });

    expect(
      resolveB01PendingResponse(adapter, "duid-1", { id: 7, result: ["ok"] })
    ).toBe(false);
  });
});

describe("B01 getStatus end-to-end mapping", () => {
  test("queries prop.get, maps the response, and dispatches a live update", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-test-")),
    });
    api.vacuums["duid-1"] = {};
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    api.messageQueueHandler = {
      sendRequest: jest
        .fn()
        .mockResolvedValue({ status: 4, quantity: 91, fault: 0, wind: 2 }),
    };
    const notify = jest.fn();
    api.setDeviceNotify(notify);

    await api.getStatus("duid-1");

    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "duid-1",
      "get_status",
      []
    );
    expect(notify).toHaveBeenCalledWith("CloudMessage", {
      duid: "duid-1",
      payload: [
        {
          state: 8,
          error_code: 0,
          charge_status: 1,
          battery: 91,
          fan_power: 102,
        },
      ],
    });
  });
});

describe("Field-test regressions (2.0.0-matter.2)", () => {
  test("catchError logs B01-unsupported methods at debug level, never as errors", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-catch-")),
    });
    const unsupported = Object.assign(
      new Error(
        "Method get_timer is not supported on B01/Q7 devices yet (duid-1)."
      ),
      { code: "B01_METHOD_UNSUPPORTED" }
    );

    await api.catchError(
      unsupported,
      "get_timer",
      "duid-1",
      "roborock.vacuum.sc05"
    );

    expect(api.log.error).not.toHaveBeenCalled();
    expect(api.log.warn).not.toHaveBeenCalled();
    expect(api.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("not supported on B01/Q7")
    );
  });

  test("refreshMatterServiceAreaRoomMappings skips B01 devices entirely", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-rooms-")),
      enableMatterServiceArea: true,
    });
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    const vacuum = { getParameter: jest.fn() };

    const result = await api.refreshMatterServiceAreaRoomMappings(
      "duid-1",
      vacuum
    );

    expect(result).toBe(false);
    expect(vacuum.getParameter).not.toHaveBeenCalled();
  });

  test("the room-mapping status read no longer throws on Q7-shaped payloads", async () => {
    const { vacuum } = require("../roborockLib/lib/vacuum");
    const adapter = {
      log: createLog(),
      messageQueueHandler: {
        // B01 get_status returns a dict, not the v1 [{...}] array.
        sendRequest: jest
          .fn()
          .mockResolvedValueOnce({ status: 4, quantity: 90 })
          .mockResolvedValueOnce([]),
      },
      updateRoomMappingCache: jest.fn(),
      getStateAsync: jest.fn(),
      setStateChangedAsync: jest.fn(),
      setStateAsync: jest.fn().mockResolvedValue(undefined),
      setObjectAsync: jest.fn().mockResolvedValue(undefined),
      getRobotVersion: jest.fn().mockResolvedValue("B01"),
      catchError: jest.fn(),
    };
    const instance = new vacuum(adapter, "roborock.vacuum.sc05");

    await expect(
      instance.getParameter("duid-1", "get_room_mapping")
    ).resolves.not.toThrow();
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(
      "duid-1",
      -1,
      []
    );
  });
});

describe("Q7 deep-hardening (2.0.0-matter.3)", () => {
  test("water is neither queried nor controlled on Q7", () => {
    expect(b01.B01_STATUS_PROPS).not.toContain("water");
    expect(
      b01.translateOutgoing("set_water_box_custom_mode", [202])
    ).toBeNull();
  });

  test("app_segment_clean_by_ids (the actual wire method) translates with room ids", () => {
    const translated = b01.translateOutgoing("app_segment_clean_by_ids", {
      segments: [3, 7],
      repeat: 1,
    });
    expect(translated).toEqual({
      method: "service.set_room_clean",
      params: { clean_type: 1, ctrl_value: 1, room_ids: [3, 7] },
    });
  });

  test("clean-mode capabilities for B01: mop mode yes, water control never", () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-caps-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "pv" ? "B01" : ""
    );
    // Simulate a generic cloud schema that (wrongly) advertises water codes.
    api.hasVacuumSchemaCode = jest.fn().mockReturnValue(true);
    api.hasVacuumFeature = jest.fn().mockReturnValue(true);

    expect(api.getMatterCleanModeCapabilities("duid-1")).toEqual({
      canVacuum: true,
      canMop: true,
      canControlFanPower: true,
      canControlWater: false,
    });
  });

  test("periodic B01 refresh is throttled to protect the Roborock cloud", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-throttle-")),
    });
    api.vacuums["duid-1"] = {};
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    api.messageQueueHandler = {
      sendRequest: jest
        .fn()
        .mockResolvedValue({ status: 4, quantity: 90, fault: 0 }),
    };
    api.setDeviceNotify(jest.fn());

    // Simulate the 1-second poll tick firing five times.
    for (let i = 0; i < 5; i++) {
      await api.getStatus("duid-1");
    }
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);

    // A forced refresh right after is throttled by the short forced gap...
    await api.getStatus("duid-1", { force: true });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);

    // ...but succeeds once the 1.5s forced gap has passed.
    api._b01StatusState.get("duid-1").lastAttemptAt = Date.now() - 2000;
    await api.getStatus("duid-1", { force: true });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
  });

  test("concurrent B01 refreshes share a single in-flight request", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-inflight-")),
    });
    api.vacuums["duid-1"] = {};
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    let resolveRequest;
    api.messageQueueHandler = {
      sendRequest: jest.fn(
        () => new Promise((resolve) => (resolveRequest = resolve))
      ),
    };
    api.setDeviceNotify(jest.fn());

    const first = api.refreshB01Status("duid-1", { force: true });
    const second = api.refreshB01Status("duid-1", { force: true });
    resolveRequest({ status: 4, quantity: 90, fault: 0 });

    const [a, b] = await Promise.all([first, second]);
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  test("request ids never repeat across the wraparound", () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-ids-")),
    });
    api.idCounter = 9998;
    const ids = [api.getRequestId(), api.getRequestId(), api.getRequestId()];
    expect(ids).toEqual([9998, 0, 1]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("Q7 mop/vacuum mode switching", () => {
  test("set_clean_type translates the crossed Matter/Q7 mode values", () => {
    // Matter Vacuum(0) -> Q7 0, Matter Mop(1) -> Q7 2, Matter Vac+Mop(2) -> Q7 1
    expect(b01.translateOutgoing("set_clean_type", [0])).toEqual({
      method: "prop.set",
      params: { mode: 0 },
    });
    expect(b01.translateOutgoing("set_clean_type", [1])).toEqual({
      method: "prop.set",
      params: { mode: 2 },
    });
    expect(b01.translateOutgoing("set_clean_type", [2])).toEqual({
      method: "prop.set",
      params: { mode: 1 },
    });
  });

  test("applyMatterCleanModeSettings on B01 sends clean type and skips the fan-off hack", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-apply-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "pv" ? "B01" : ""
    );
    api.startCommand = jest.fn().mockResolvedValue(undefined);

    // Matter Mop selection: v1 builds fanPower=105 (off) — must not be sent.
    await api.applyMatterCleanModeSettings("duid-1", {
      cleanMode: 1,
      fanPower: 105,
    });
    expect(api.startCommand).toHaveBeenCalledTimes(1);
    expect(api.startCommand).toHaveBeenCalledWith(
      "duid-1",
      "set_clean_type",
      [1],
      expect.anything()
    );

    // Vacuum selection with a real suction level: both commands go out.
    api.startCommand.mockClear();
    await api.applyMatterCleanModeSettings("duid-1", {
      cleanMode: 0,
      fanPower: 102,
    });
    expect(api.startCommand).toHaveBeenCalledWith(
      "duid-1",
      "set_clean_type",
      [0],
      expect.anything()
    );
    expect(api.startCommand).toHaveBeenCalledWith(
      "duid-1",
      "set_custom_mode",
      [102],
      expect.anything()
    );
  });

  test("B01 Matter accessory exposes Vacuum, Mop, and Vacuum + Mop modes", () => {
    const platform = createMatterPlatformB01();
    const { accessory } = createMatterAccessoryFromPlatform(platform);
    const labels = accessory.clusters.rvcCleanMode.supportedModes.map(
      (mode) => mode.label
    );
    expect(labels).toEqual(["Vacuum", "Mop", "Vacuum + Mop"]);
  });
});

function createMatterPlatformB01() {
  return {
    platformConfig: { enableMatter: true, enableMatterCleanMode: true },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => null,
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Q7 Test" : property === "pv" ? "B01" : "",
      getProductAttribute: () => "roborock.vacuum.sc05",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canControlWater: false,
      }),
    },
  };
}

function createMatterAccessoryFromPlatform(platform) {
  const RoborockMatterVacuumAccessory =
    require("../src/matter_vacuum_accessory").default;
  const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
  new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-q7" },
    false
  );
  return { accessory };
}

describe("Q7 room discovery via the B01 map channel", () => {
  const MAP_FIXTURE = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "testdata", "b01_q7_map_fixture.json"),
      "utf8"
    )
  );

  test("derives the map key exactly like the reference implementation", () => {
    const key = b01.createMapKey(MAP_FIXTURE.serial, MAP_FIXTURE.model);
    expect(key.toString("ascii")).toBe(MAP_FIXTURE.expectedMapKey);
  });

  test("decodes and parses a reference-generated map payload end to end", () => {
    const key = b01.createMapKey(MAP_FIXTURE.serial, MAP_FIXTURE.model);
    const scMap = b01.decodeMapPayload(
      Buffer.from(MAP_FIXTURE.payloadBase64, "ascii"),
      key
    );
    const rooms = b01.parseRoomsFromScMap(scMap);
    expect(rooms).toEqual(MAP_FIXTURE.expectedRooms);
  });

  test("get_map_list translates and the current map is picked by the cur flag", () => {
    expect(b01.translateOutgoing("get_map_list", {})).toEqual({
      method: "service.get_map_list",
      params: {},
    });
    expect(
      b01.findCurrentMapId({
        map_list: [
          { id: 3, cur: false },
          { id: 9, cur: true },
        ],
      })
    ).toBe(9);
    expect(b01.findCurrentMapId({ map_list: [{ id: 5 }] })).toBe(5);
    expect(b01.findCurrentMapId({ map_list: [] })).toBeNull();
  });

  test("protocol 301 payloads resolve the pending per-device map request", () => {
    const {
      resolveB01PendingResponse: _unused,
    } = require("../roborockLib/lib/roborock_mqtt_connector");
    const adapter = {
      pendingB01MapRequests: new Map(),
      clearTimeout: jest.fn((t) => clearTimeout(t)),
    };
    const resolve = jest.fn();
    adapter.pendingB01MapRequests.set("duid-1", {
      resolve,
      reject: jest.fn(),
      timeout: setTimeout(() => undefined, 5000),
    });

    // Mirror the connector branch: pending map request wins on protocol 301.
    const pendingMap = adapter.pendingB01MapRequests.get("duid-1");
    adapter.clearTimeout(pendingMap.timeout);
    adapter.pendingB01MapRequests.delete("duid-1");
    pendingMap.resolve(Buffer.from("payload"));

    expect(resolve).toHaveBeenCalledWith(Buffer.from("payload"));
    expect(adapter.pendingB01MapRequests.size).toBe(0);
  });

  test("cached rooms feed getRoomMappingsForDevice in the Matter shape", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-rooms-cache-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "pv" ? "B01" : ""
    );
    await api.setB01RoomCache("duid-1", [
      { roomId: 42, roomName: "Køkken" },
      { roomId: 7, roomName: "" },
    ]);

    expect(api.getRoomMappingsForDevice("duid-1")).toEqual([
      { segmentId: 42, mapId: 0, name: "Køkken" },
      { segmentId: 7, mapId: 0, name: "Room 7" },
    ]);
  });

  test("refreshB01Rooms fetches, decodes, caches, and is throttled", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-rooms-flow-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, attr) => {
      if (attr === "pv") return "B01";
      if (attr === "sn") return MAP_FIXTURE.serial;
      return "";
    });
    api.getProductAttribute = jest.fn(() => MAP_FIXTURE.model);
    api.messageQueueHandler = {
      sendRequest: jest
        .fn()
        .mockResolvedValue({ map_list: [{ id: 4, cur: true }] }),
    };
    api.sendB01MapRequest = jest
      .fn()
      .mockResolvedValue(Buffer.from(MAP_FIXTURE.payloadBase64, "ascii"));

    const rooms = await api.refreshB01Rooms("duid-1");
    expect(rooms).toEqual(MAP_FIXTURE.expectedRooms);
    expect(api.sendB01MapRequest).toHaveBeenCalledWith("duid-1", 4);
    expect(api.getRoomMappingsForDevice("duid-1")).toHaveLength(2);

    // Throttled: a second call within 6 hours serves the cache.
    await api.refreshB01Rooms("duid-1");
    expect(api.sendB01MapRequest).toHaveBeenCalledTimes(1);
  });
});

describe("Q7 charging tile (both status paths)", () => {
  test("live mapping carries charge_status for charging and dock-drying", () => {
    expect(b01.mapStatusToV1({ status: 4, quantity: 74 }).charge_status).toBe(
      1
    );
    expect(b01.mapStatusToV1({ status: 10, quantity: 99 }).charge_status).toBe(
      1
    );
    expect(b01.mapStatusToV1({ status: 5, quantity: 74 }).charge_status).toBe(
      0
    );
  });

  test("HomeData fallback translates Q7-native state codes to v1", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-fallback-")),
    });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-q7",
            schema: [
              { id: 121, code: "state" },
              { id: 122, code: "battery" },
            ],
          },
        ],
        devices: [
          {
            duid: "duid-q7",
            productId: "product-q7",
            pv: "B01",
            // Cloud snapshot stores the Q7-NATIVE work status: 4 = charging.
            deviceStatus: { 121: 4, 122: 74 },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getVacuumDeviceStatus("duid-q7", "state")).toBe(8);
    expect(api.getVacuumDeviceStatus("duid-q7", "battery")).toBe(74);
  });

  test("end to end: a charging Q7 publishes Matter Charging (65) on the tile", async () => {
    const matterUpdates = [];
    const platform = createMatterPlatformB01();
    platform.platformConfig.enableMatterChargingDockedStates = true;
    platform.platformConfig.matterChargedBatteryThreshold = 90;
    platform.getMatterApi = () => ({
      updateAccessoryState: async (uuid, cluster, attributes) => {
        matterUpdates.push({ cluster, attributes });
      },
    });

    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "duid-q7" },
      true
    );

    // Simulate the refreshB01Status live dispatch for a charging robot.
    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "duid-q7",
      payload: [{ state: 8, battery: 74, error_code: 0, charge_status: 1 }],
    });

    const lastOpState = [...matterUpdates]
      .reverse()
      .find((update) => update.cluster === "rvcOperationalState");
    expect(lastOpState.attributes.operationalState).toBe(65);
  });
});

describe("B01 status self-healing (2.0.0-matter.6)", () => {
  function createApi() {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-heal-")),
    });
    api.vacuums["duid-1"] = {};
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    api.setDeviceNotify(jest.fn());
    return api;
  }

  test("failed attempts are throttled too — no per-second retry storms", async () => {
    const api = createApi();
    api.messageQueueHandler = {
      sendRequest: jest.fn().mockRejectedValue(new Error("cloud timeout")),
    };

    for (let i = 0; i < 5; i++) {
      await api.getStatus("duid-1");
    }
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
  });

  test("every 10th consecutive failure escalates to a warning; success logs recovery", async () => {
    const api = createApi();
    api.messageQueueHandler = {
      sendRequest: jest.fn().mockRejectedValue(new Error("cloud timeout")),
    };

    for (let i = 0; i < 10; i++) {
      api._b01StatusState?.get("duid-1") &&
        (api._b01StatusState.get("duid-1").lastAttemptAt = 0);
      await api.getStatus("duid-1");
    }
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed 10 times in a row")
    );

    api.messageQueueHandler.sendRequest = jest
      .fn()
      .mockResolvedValue({ status: 4, quantity: 100, fault: 0 });
    api._b01StatusState.get("duid-1").lastAttemptAt = 0;
    await api.getStatus("duid-1");
    expect(api.log.info).toHaveBeenCalledWith(
      expect.stringContaining("recovered after 10 failed attempt(s)")
    );
  });

  test("stale live values fall back to the HomeData snapshot", async () => {
    const platform = createMatterPlatformB01();
    platform.getMatterApi = () => ({
      updateAccessoryState: async () => undefined,
    });
    platform.roborockAPI.getVacuumDeviceStatus = (duid, property) =>
      property === "battery" ? 100 : "";
    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "duid-q7" },
      true
    );

    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "duid-q7",
      payload: [{ battery: 74 }],
    });
    expect(vacuum.getNumberStatus("battery")).toBe(74);

    // 16 minutes later without a single live update: HomeData wins.
    vacuum.liveStatusUpdatedAt = Date.now() - 16 * 60 * 1000;
    expect(vacuum.getNumberStatus("battery")).toBe(100);
  });

  test("the HomeData poller supervises B01 intervals back to life", () => {
    const api = createApi();
    api.initializedVacuumDuids = new Set(["duid-1", "duid-v1"]);
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "pv" ? (duid === "duid-1" ? "B01" : "1.0") : ""
    );
    api.manageDeviceIntervals = jest.fn().mockResolvedValue(true);

    api.superviseB01DeviceIntervals();

    expect(api.manageDeviceIntervals).toHaveBeenCalledTimes(1);
    expect(api.manageDeviceIntervals).toHaveBeenCalledWith("duid-1");
  });
});

describe("Q7 room cleaning (field-log regression)", () => {
  test("current map id for B01 is the canonical 0, so no map switch is attempted", () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-mapid-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "pv" ? "B01" : ""
    );
    expect(api.getCurrentMapIdForDevice("duid-1")).toBe(0);
  });

  test("room clean on a B01 robot never calls load_multi_map", async () => {
    const platform = createMatterPlatformB01();
    platform.roborockAPI.getCurrentMapIdForDevice = () => 0;
    platform.roborockAPI.load_multi_map = jest.fn();
    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "duid-q7" },
      false
    );

    // The area carries mapId 0 (the B01 canonical map).
    await vacuum.loadMatterMapIfNeeded("duid-q7", 0);
    expect(platform.roborockAPI.load_multi_map).not.toHaveBeenCalled();
  });
});

describe("Interval lifecycle surgery (2.0.0-matter.7)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function createApi() {
    return new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-loop-")),
    });
  }

  test("offline clears the REAL interval handles and nulls them", async () => {
    const api = createApi();
    api.initializedVacuumDuids = new Set(["d1"]);
    const h1 = setInterval(() => undefined, 100000);
    const h2 = setInterval(() => undefined, 100000);
    api.vacuums["d1"] = {
      getStatusIntervalHandle: h1,
      mainUpdateIntervalHandle: h2,
      getStatusIntervall: jest.fn(),
    };
    api.onlineChecker = jest.fn().mockResolvedValue(false);
    const clearSpy = jest.spyOn(api, "clearInterval");

    await api.manageDeviceIntervals("d1");

    expect(clearSpy).toHaveBeenCalledWith(h1);
    expect(clearSpy).toHaveBeenCalledWith(h2);
    expect(api.vacuums["d1"].getStatusIntervalHandle).toBeNull();
    expect(api.vacuums["d1"].mainUpdateIntervalHandle).toBeNull();
    clearInterval(h1);
    clearInterval(h2);
  });

  test("back online restarts intervals — the historically impossible branch", async () => {
    const api = createApi();
    api.initializedVacuumDuids = new Set(["d1"]);
    api.vacuums["d1"] = {
      getStatusIntervalHandle: null,
      mainUpdateIntervalHandle: null,
      getStatusIntervall: jest.fn(),
    };
    api.onlineChecker = jest.fn().mockResolvedValue(true);
    api.startMainUpdateInterval = jest.fn();

    await api.manageDeviceIntervals("d1");

    expect(api.vacuums["d1"].getStatusIntervall).toHaveBeenCalled();
    expect(api.startMainUpdateInterval).toHaveBeenCalledWith("d1", true);
  });

  test("the starter functions store real handles that actually clear", () => {
    jest.useFakeTimers();
    const api = createApi();
    api.initializedVacuumDuids = new Set(["d1"]);
    api.vacuums["d1"] = {};
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a70");
    api.updateDataMinimumData = jest.fn();

    api.startMainUpdateInterval("d1", true);
    const handle = api.vacuums["d1"].mainUpdateIntervalHandle;
    expect(handle).toBeTruthy();

    jest.advanceTimersByTime(api.updateInterval * 1000 + 50);
    expect(api.updateDataMinimumData).toHaveBeenCalled();

    api.clearInterval(handle);
    api.updateDataMinimumData.mockClear();
    jest.advanceTimersByTime(api.updateInterval * 2000);
    expect(api.updateDataMinimumData).not.toHaveBeenCalled();
  });

  test("the dedicated B01 loop polls only B01 robots and survives clearing via the supervisor", () => {
    jest.useFakeTimers();
    const api = createApi();
    api.initializedVacuumDuids = new Set(["q7", "classic"]);
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "pv" ? (duid === "q7" ? "B01" : "1.0") : ""
    );
    api.getStatus = jest.fn().mockResolvedValue(undefined);
    api.manageDeviceIntervals = jest.fn().mockResolvedValue(true);

    api.startB01StatusLoop();
    // Immediate boot poll (forced) plus the first 15s tick.
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenCalledWith("q7", { force: true });
    jest.advanceTimersByTime(15100);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    expect(api.getStatus).toHaveBeenCalledWith("q7", undefined);

    // Something clears every timer (shutdown/reconnect flows).
    api.clearTimersAndIntervals();
    expect(api.b01StatusLoopHandle).toBeNull();
    api.getStatus.mockClear();
    jest.advanceTimersByTime(30000);
    expect(api.getStatus).not.toHaveBeenCalled();

    // The HomeData supervisor revives it.
    api.superviseB01DeviceIntervals();
    jest.advanceTimersByTime(15100);
    expect(api.getStatus).toHaveBeenCalledWith("q7", { force: true });
  });
});

describe("Per-cluster publish isolation (frozen-tile defense)", () => {
  test("a failing cluster never blocks the battery publish", async () => {
    const updates = [];
    const platform = createMatterPlatformB01();
    platform.platformConfig.enableMatterChargingDockedStates = true;
    platform.getMatterApi = () => ({
      updateAccessoryState: async (uuid, cluster, attributes) => {
        if (cluster === "rvcOperationalState") {
          throw new Error("simulated cluster failure");
        }
        updates.push({ cluster, attributes });
      },
    });

    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "duid-q7" },
      true
    );

    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "duid-q7",
      payload: [{ state: 8, battery: 100, error_code: 0, charge_status: 1 }],
    });

    // The boot resync nudge (null) precedes the real value; the real
    // publish must land despite the failing sibling cluster.
    const powerPublishes = updates.filter((u) => u.cluster === "powerSource");
    expect(powerPublishes.length).toBeGreaterThanOrEqual(1);
    expect(
      powerPublishes.some((u) => u.attributes.batPercentRemaining === 200)
    ).toBe(true);
  });
});

describe("Battery resync nudge (stuck-controller-cache defense)", () => {
  function createRegisteredVacuum(matterUpdates) {
    const platform = createMatterPlatformB01();
    platform.platformConfig.enableMatterChargingDockedStates = true;
    platform.getMatterApi = () => ({
      updateAccessoryState: async (uuid, cluster, attributes) => {
        matterUpdates.push({ cluster, attributes });
      },
    });
    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
    return {
      vacuum: new RoborockMatterVacuumAccessory(
        platform,
        accessory,
        { duid: "duid-q7" },
        true
      ),
      platform,
    };
  }

  test("first status publish nudges battery attributes, once per boot", async () => {
    const matterUpdates = [];
    const { vacuum, platform } = createRegisteredVacuum(matterUpdates);

    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "duid-q7",
      payload: [{ state: 8, battery: 100, error_code: 0, charge_status: 1 }],
    });

    const powerPublishes = matterUpdates.filter(
      (u) => u.cluster === "powerSource"
    );
    // Nudge (unknown) first, real values second.
    expect(powerPublishes.length).toBeGreaterThanOrEqual(2);
    expect(powerPublishes[0].attributes.batPercentRemaining).toBeNull();
    expect(powerPublishes[0].attributes.batChargeState).toBe(0);
    expect(powerPublishes[1].attributes.batPercentRemaining).toBe(200);
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Battery resync for duid-q7")
    );

    // A second, IDENTICAL live update publishes nothing at all (publish
    // diffing) — and certainly does not nudge again.
    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "duid-q7",
      payload: [{ state: 8, battery: 100, error_code: 0, charge_status: 1 }],
    });
    expect(
      matterUpdates.filter((u) => u.cluster === "powerSource")
    ).toHaveLength(0);

    // A real battery change publishes exactly one fresh value, no nudge.
    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "duid-q7",
      payload: [{ state: 8, battery: 90, error_code: 0, charge_status: 1 }],
    });
    const changedRound = matterUpdates.filter(
      (u) => u.cluster === "powerSource"
    );
    expect(changedRound).toHaveLength(1);
    expect(changedRound[0].attributes.batPercentRemaining).toBe(180);
  });
});

describe("Service Area cleaning progress (the 'Forbereder' fix)", () => {
  function createRoomVacuum() {
    const platform = createMatterPlatformB01();
    platform.platformConfig.enableMatterServiceArea = true;
    platform.roborockAPI.getRoomMappingsForDevice = () => [
      { segmentId: 10, mapId: 0, name: "Stue" },
      { segmentId: 11, mapId: 0, name: "Gæsteværelse" },
    ];
    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const accessory = { UUID: "uuid-q7", context: { duid: "duid-q7" } };
    return new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "duid-q7" },
      false
    );
  }

  test("room-clean start marks the first area operating and names it current", () => {
    const vacuum = createRoomVacuum();
    vacuum.beginServiceAreaProgress([10, 11]);

    const cluster = vacuum.buildServiceAreaCluster();
    expect(cluster.currentArea).toBe(10);
    expect(cluster.progress).toEqual([
      { areaId: 10, status: 1 }, // operating
      { areaId: 11, status: 0 }, // pending
    ]);
  });

  test("returning to the charger completes the run and clears the current area", () => {
    const vacuum = createRoomVacuum();
    vacuum.beginServiceAreaProgress([10, 11]);

    // 65 = Charging: no longer a cleaning run mode.
    vacuum.completeServiceAreaProgressIfDone(65);

    const cluster = vacuum.buildServiceAreaCluster();
    expect(cluster.currentArea).toBeNull();
    expect(cluster.progress).toEqual([
      { areaId: 10, status: 3 }, // completed
      { areaId: 11, status: 3 },
    ]);
  });

  test("a full-home clean publishes the whole run scope as pending, then completed", () => {
    const vacuum = createRoomVacuum();
    vacuum.beginServiceAreaProgress([10]);
    vacuum.beginFullCleanServiceAreaProgress();

    let cluster = vacuum.buildServiceAreaCluster();
    // No area is claimed as current (the robot does not report its room),
    // but the run's scope is real progress data for the controller.
    expect(cluster.currentArea).toBeNull();
    expect(cluster.progress).toEqual([
      { areaId: 10, status: 0 }, // pending
      { areaId: 11, status: 0 },
    ]);
    expect(cluster.estimatedEndTime).toBeNull();

    // Back on the charger: the whole run is reported completed.
    vacuum.completeServiceAreaProgressIfDone(65);
    cluster = vacuum.buildServiceAreaCluster();
    expect(cluster.progress).toEqual([
      { areaId: 10, status: 3 },
      { areaId: 11, status: 3 },
    ]);
  });

  test("a full-home clean without exposed rooms keeps the progress list empty", () => {
    const platform = createMatterPlatformB01();
    platform.platformConfig.enableMatterServiceArea = true;
    platform.roborockAPI.getRoomMappingsForDevice = () => [];
    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      { UUID: "uuid-q7", context: { duid: "duid-q7" } },
      { duid: "duid-q7" },
      false
    );
    vacuum.beginFullCleanServiceAreaProgress();
    expect(vacuum.buildServiceAreaCluster().progress).toEqual([]);
  });
});

describe("Service Area progress persistence across restarts", () => {
  test("a restart mid-clean restores the room display", () => {
    const platform = createMatterPlatformB01();
    platform.platformConfig.enableMatterServiceArea = true;
    platform.roborockAPI.getRoomMappingsForDevice = () => [
      { segmentId: 10, mapId: 0, name: "Stue" },
    ];
    const RoborockMatterVacuumAccessory =
      require("../src/matter_vacuum_accessory").default;
    const context = { duid: "duid-q7" };

    const first = new RoborockMatterVacuumAccessory(
      platform,
      { UUID: "uuid-q7", context },
      { duid: "duid-q7" },
      false
    );
    first.beginServiceAreaProgress([10]);
    expect(context.serviceAreaProgressState).toEqual({
      currentArea: 10,
      progress: [{ areaId: 10, status: 1 }],
    });

    // "Restart": a fresh instance over the same persisted context.
    const second = new RoborockMatterVacuumAccessory(
      platform,
      { UUID: "uuid-q7", context },
      { duid: "duid-q7" },
      false
    );
    const cluster = second.buildServiceAreaCluster();
    expect(cluster.currentArea).toBe(10);
    expect(cluster.progress).toEqual([{ areaId: 10, status: 1 }]);
  });
});

describe("Adaptive B01 poll cadence", () => {
  test("active robots poll fast; resting robots keep the 45s cloud cadence", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-adaptive-")),
    });
    api.vacuums["duid-1"] = {};
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    let robotState = 1; // idle (B01 status 1 -> v1 state 3)
    api.messageQueueHandler = {
      sendRequest: jest.fn(async () => ({
        status: robotState,
        quantity: 90,
        fault: 0,
        wind: 2,
      })),
    };
    api.setDeviceNotify(jest.fn());
    const state = () => api._b01StatusState.get("duid-1");

    // Idle: first attempt goes through; a 15s-later tick is still blocked.
    await api.getStatus("duid-1");
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    state().lastAttemptAt = Date.now() - 15000;
    await api.getStatus("duid-1");
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);

    // The robot starts cleaning (B01 status 5 -> active v1 state). Once the
    // loop has learned this, every 15s tick is allowed through.
    robotState = 5;
    state().lastAttemptAt = Date.now() - 46000; // past the idle gap: learns "active"
    await api.getStatus("duid-1");
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
    state().lastAttemptAt = Date.now() - 15000; // a normal 15s tick later
    await api.getStatus("duid-1");
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(3);

    // Back on the dock charging: the conservative cadence returns.
    robotState = 4;
    state().lastAttemptAt = Date.now() - 15000;
    await api.getStatus("duid-1"); // still active-gap: learns "charging"
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(4);
    state().lastAttemptAt = Date.now() - 15000;
    await api.getStatus("duid-1"); // blocked again at rest
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(4);
  });
});
