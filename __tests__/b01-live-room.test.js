const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const b01 = require("../roborockLib/lib/b01Q7Adapter");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire ENCODER mirroring the b01_scmap.proto schema, so the
// tests exercise the real decoder against independently constructed bytes.
// ---------------------------------------------------------------------------

function varint(value) {
  const out = [];
  let remaining = value;
  while (remaining > 127) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
  return Buffer.from(out);
}

function tag(fieldNumber, wireType) {
  return varint(fieldNumber * 8 + wireType);
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([tag(fieldNumber, 0), varint(value)]);
}

function encodeFloatField(fieldNumber, value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value);
  return Buffer.concat([tag(fieldNumber, 5), buf]);
}

function encodeLengthDelimited(fieldNumber, body) {
  return Buffer.concat([tag(fieldNumber, 2), varint(body.length), body]);
}

// MapHeadInfo: sizeX=2, sizeY=3, minX=4, minY=5, maxX=6, maxY=7, resolution=8
function encodeMapHead({ sizeX, sizeY, minX, minY, resolution }) {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, sizeX),
    encodeVarintField(3, sizeY),
    encodeFloatField(4, minX),
    encodeFloatField(5, minY),
    encodeFloatField(6, minX + sizeX * resolution),
    encodeFloatField(7, minY + sizeY * resolution),
    encodeFloatField(8, resolution),
  ]);
}

// DeviceCurrentPoseInfo: poseId=1, update=2, x=3, y=4, phi=5
function encodePose(x, y) {
  return Buffer.concat([
    encodeVarintField(1, 123),
    encodeVarintField(2, 1),
    encodeFloatField(3, x),
    encodeFloatField(4, y),
    encodeFloatField(5, 1.57),
  ]);
}

// RoomDataInfo: roomId=1, roomName=2
function encodeRoom(roomId, roomName) {
  return Buffer.concat([
    encodeVarintField(1, roomId),
    encodeLengthDelimited(2, Buffer.from(roomName, "utf8")),
  ]);
}

// DeviceRoomChainDataInfo: roomId=1, points=2 (x=1, y=2, value=3)
function encodeRoomChain(roomId, cellPoints) {
  const parts = [encodeVarintField(1, roomId)];
  for (const [x, y] of cellPoints) {
    parts.push(
      encodeLengthDelimited(
        2,
        Buffer.concat([
          encodeVarintField(1, x),
          encodeVarintField(2, y),
          encodeVarintField(3, 1),
        ])
      )
    );
  }
  return Buffer.concat(parts);
}

const HEAD = {
  sizeX: 100,
  sizeY: 80,
  minX: -2.5,
  minY: -1.5,
  resolution: 0.05,
};
// Two rectangular rooms in grid-cell coordinates: Køkken (42) on the left,
// Stue (7) on the right, separated by an unassigned corridor at x 40..50.
const KITCHEN_CHAIN = [
  [10, 10],
  [40, 10],
  [40, 40],
  [10, 40],
];
const LIVING_CHAIN = [
  [50, 10],
  [90, 10],
  [90, 70],
  [50, 70],
];

function cellToWorld(cellX, cellY) {
  return [
    HEAD.minX + cellX * HEAD.resolution,
    HEAD.minY + cellY * HEAD.resolution,
  ];
}

function encodeRobotMap({ pose, includeGeometry = true } = {}) {
  const parts = [encodeVarintField(1, 0)];
  if (includeGeometry) {
    parts.push(encodeLengthDelimited(3, encodeMapHead(HEAD)));
  }
  // An unrelated submessage (historyPose, field 6) the parser must skip.
  parts.push(
    encodeLengthDelimited(
      6,
      Buffer.concat([
        encodeVarintField(1, 9),
        encodeLengthDelimited(
          2,
          Buffer.concat([
            encodeVarintField(1, 1),
            encodeFloatField(2, 0.1),
            encodeFloatField(3, 0.2),
          ])
        ),
      ])
    )
  );
  if (pose) {
    parts.push(encodeLengthDelimited(8, encodePose(pose[0], pose[1])));
  }
  parts.push(encodeLengthDelimited(12, encodeRoom(42, "Køkken")));
  parts.push(encodeLengthDelimited(12, encodeRoom(7, "Stue")));
  if (includeGeometry) {
    parts.push(encodeLengthDelimited(14, encodeRoomChain(42, KITCHEN_CHAIN)));
    parts.push(encodeLengthDelimited(14, encodeRoomChain(7, LIVING_CHAIN)));
  }
  return Buffer.concat(parts);
}

// Inverse of decodeMapPayload: SCMap -> deflate -> ascii hex -> AES-128-ECB
// encrypt -> base64, so the API-level tests run the production decode path.
function encodeMapPayload(scMap, mapKey) {
  const compressedHex = zlib.deflateSync(scMap).toString("hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", mapKey, null);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(compressedHex, "ascii")),
    cipher.final(),
  ]);
  return Buffer.from(encrypted.toString("base64"), "ascii");
}

const SERIAL = "RCOEHP52901640";
const MODEL = "roborock.vacuum.sc05";

describe("SCMap live-state parsing", () => {
  test("extracts map head, pose, rooms and room chains; skips unknown fields", () => {
    const parsed = b01.parseScMapLiveState(
      encodeRobotMap({ pose: cellToWorld(20, 20) })
    );

    expect(parsed.head.sizeX).toBe(100);
    expect(parsed.head.sizeY).toBe(80);
    expect(parsed.head.minX).toBeCloseTo(-2.5, 5);
    expect(parsed.head.minY).toBeCloseTo(-1.5, 5);
    expect(parsed.head.resolution).toBeCloseTo(0.05, 5);
    expect(parsed.pose.x).toBeCloseTo(-1.5, 5);
    expect(parsed.pose.y).toBeCloseTo(-0.5, 5);
    expect(parsed.rooms).toEqual([
      { roomId: 42, roomName: "Køkken" },
      { roomId: 7, roomName: "Stue" },
    ]);
    expect(parsed.roomChains.map((chain) => chain.roomId)).toEqual([42, 7]);
    expect(parsed.roomChains[0].points).toHaveLength(4);
  });

  test("resolves the room whose outline contains the pose", () => {
    const inKitchen = b01.parseScMapLiveState(
      encodeRobotMap({ pose: cellToWorld(20, 20) })
    );
    expect(b01.describeLiveRoomResolution(inKitchen).roomId).toBe(42);

    const inLivingRoom = b01.parseScMapLiveState(
      encodeRobotMap({ pose: cellToWorld(70, 40) })
    );
    expect(b01.describeLiveRoomResolution(inLivingRoom).roomId).toBe(7);
  });

  test("returns null when the pose is outside every room outline", () => {
    const inCorridor = b01.parseScMapLiveState(
      encodeRobotMap({ pose: cellToWorld(45, 45) })
    );
    expect(b01.describeLiveRoomResolution(inCorridor).roomId).toBeNull();
  });

  test("returns null when pose or geometry is missing", () => {
    const noPose = b01.parseScMapLiveState(encodeRobotMap({ pose: null }));
    expect(noPose.pose).toBeNull();
    expect(b01.describeLiveRoomResolution(noPose).roomId).toBeNull();

    const noGeometry = b01.parseScMapLiveState(
      encodeRobotMap({ pose: cellToWorld(20, 20), includeGeometry: false })
    );
    expect(b01.describeLiveRoomResolution(noGeometry).roomId).toBeNull();
  });

  test("parseRoomsFromScMap keeps its original contract on the same payload", () => {
    expect(b01.parseRoomsFromScMap(encodeRobotMap({ pose: null }))).toEqual([
      { roomId: 42, roomName: "Køkken" },
      { roomId: 7, roomName: "Stue" },
    ]);
  });
});

describe("refreshB01LiveRoom", () => {
  function createApi(options = {}) {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-live-room-")),
      ...options,
    });
    api.vacuums["duid-q7"] = {};
    api.getVacuumDeviceInfo = jest.fn((duid, property) =>
      property === "sn" ? SERIAL : ""
    );
    api.getProductAttribute = jest.fn(() => MODEL);
    api.messageQueueHandler = {
      sendRequest: jest.fn(async (duid, method) =>
        method === "get_map_list" ? { map_list: [{ id: 1, cur: true }] } : {}
      ),
    };
    const mapKey = b01.createMapKey(SERIAL, MODEL);
    api.sendB01MapRequest = jest.fn(async () =>
      encodeMapPayload(api.__scMap, mapKey)
    );
    api.__scMap = encodeRobotMap({ pose: cellToWorld(20, 20) });
    return api;
  }

  test("derives the live room end to end and refreshes the room-name cache", async () => {
    const api = createApi();
    const notify = jest.fn();
    api.setDeviceNotify(notify);
    api._b01StatusState = new Map([
      ["duid-q7", { lastV1Status: { state: 5, battery: 77 } }],
    ]);

    const result = await api.refreshB01LiveRoom("duid-q7");
    expect(result).toMatchObject({ segmentId: 42, roomName: "Køkken" });
    expect(api.getB01LiveRoomForDevice("duid-q7")).toMatchObject({
      segmentId: 42,
      roomName: "Køkken",
    });

    // The paid-for map payload also refreshed the room-name cache.
    expect(api.getB01RoomCache("duid-q7")).toEqual([
      { roomId: 42, roomName: "Køkken" },
      { roomId: 7, roomName: "Stue" },
    ]);

    // The room CHANGE re-broadcast the cached v1 status for a prompt publish.
    expect(notify).toHaveBeenCalledWith("CloudMessage", {
      duid: "duid-q7",
      payload: [{ state: 5, battery: 77 }],
    });
  });

  test("throttles attempts and keeps the last room while the robot is between outlines", async () => {
    const api = createApi();
    const notify = jest.fn();
    api.setDeviceNotify(notify);
    api._b01StatusState = new Map([
      ["duid-q7", { lastV1Status: { state: 5 } }],
    ]);

    await api.refreshB01LiveRoom("duid-q7");
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);

    // Within the 20s gap: no new fetch, cached room returned.
    const cached = await api.refreshB01LiveRoom("duid-q7");
    expect(cached).toMatchObject({ segmentId: 42 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);

    // Past the gap, robot now in the corridor: fetch happens, previous room
    // is retained, and no change notification fires.
    api.__scMap = encodeRobotMap({ pose: cellToWorld(45, 45) });
    api._b01LiveRoomState.get("duid-q7").lastAttemptAt = Date.now() - 21000;
    const retained = await api.refreshB01LiveRoom("duid-q7");
    expect(retained).toMatchObject({ segmentId: 42 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);

    // Robot moves to the living room: change detected and re-broadcast.
    api.__scMap = encodeRobotMap({ pose: cellToWorld(70, 40) });
    api._b01LiveRoomState.get("duid-q7").lastAttemptAt = Date.now() - 21000;
    const moved = await api.refreshB01LiveRoom("duid-q7");
    expect(moved).toMatchObject({ segmentId: 7, roomName: "Stue" });
    expect(notify).toHaveBeenCalledTimes(2);

    api.clearB01LiveRoom("duid-q7");
    expect(api.getB01LiveRoomForDevice("duid-q7")).toBeNull();
  });

  test("does nothing when live room tracking is disabled", async () => {
    const api = createApi({ enableLiveRoomTracking: false });
    const result = await api.refreshB01LiveRoom("duid-q7");
    expect(result).toBeNull();
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });

  test("getStatus triggers the refresh while cleaning and clears when the run ends", async () => {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-live-hook-")),
    });
    api.vacuums["duid-q7"] = {};
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    let robotState = 5; // B01 cleaning -> v1 state 5
    api.messageQueueHandler = {
      sendRequest: jest.fn(async () => ({
        status: robotState,
        quantity: 90,
        fault: 0,
        wind: 2,
      })),
    };
    api.setDeviceNotify(jest.fn());
    api.refreshB01LiveRoom = jest.fn(async () => null);
    api.clearB01LiveRoom = jest.fn();

    await api.getStatus("duid-q7");
    expect(api.refreshB01LiveRoom).toHaveBeenCalledWith("duid-q7");
    expect(api.clearB01LiveRoom).not.toHaveBeenCalled();

    robotState = 4; // B01 charging -> v1 state 8: run over, cache cleared.
    api._b01StatusState.get("duid-q7").lastAttemptAt = Date.now() - 46000;
    await api.getStatus("duid-q7");
    expect(api.clearB01LiveRoom).toHaveBeenCalledWith("duid-q7");
  });
});

describe("applyLiveServiceAreaRoom (Matter accessory)", () => {
  const RoborockMatterVacuumAccessory =
    require("../src/matter_vacuum_accessory").default;
  const RUNNING = 1;
  const DOCKED = 66;

  function createAccessory({ liveRoom = null } = {}) {
    const getB01LiveRoomForDevice = jest.fn(() => liveRoom);
    const platform = {
      platformConfig: { enableMatter: true },
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      getMatterApi: () => null,
      roborockAPI: {
        getVacuumDeviceInfo: (duid, property) =>
          property === "name" ? "Test Q7" : "",
        getProductAttribute: () => "roborock.vacuum.sc05",
        getVacuumDeviceStatus: () => "",
        getRoomMappingsForDevice: () => [
          { segmentId: 42, mapId: 0, name: "Køkken" },
          { segmentId: 7, mapId: 0, name: "Stue" },
        ],
        getMapListForDevice: () => [],
        getCurrentMapIdForDevice: () => 0,
        getMatterCleanModeCapabilities: () => ({
          canVacuum: true,
          canMop: true,
        }),
        getB01LiveRoomForDevice,
      },
    };
    const accessory = { UUID: "uuid-live", context: { duid: "duid-q7" } };
    const instance = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "duid-q7" },
      false
    );
    const areas = instance.getMatterServiceAreas();
    const areaBySegment = new Map(
      areas.map((area) => [area.segmentId, area.areaId])
    );
    // Observation time is what the dwell rule measures, so these tests own it
    // explicitly instead of borrowing the wall clock. The epoch is far above
    // the dwell window: a low fake epoch makes a dwell test pass on the window
    // rather than on the behaviour.
    const clock = { now: 1_800_000_000_000 };
    return {
      instance,
      platform,
      getB01LiveRoomForDevice,
      areaBySegment,
      clock,
    };
  }

  function setLiveRoom(harness, segmentId, roomName) {
    harness.getB01LiveRoomForDevice.mockReturnValue(
      segmentId === null ? null : { segmentId, roomName, at: harness.clock.now }
    );
  }

  /**
   * One NEW position sample: time passes, the API layer resolves a room, and
   * the accessory folds it in. Calling applyLiveServiceAreaRoom without going
   * through this models the opposite case — a publish cycle re-reading the
   * cached sample — and is done deliberately where that is the point.
   */
  function sight(harness, segmentId, roomName, advanceMs) {
    harness.clock.now += advanceMs;
    setLiveRoom(harness, segmentId, roomName);
    harness.instance.applyLiveServiceAreaRoom(RUNNING);
  }

  function progressById(instance) {
    return Object.fromEntries(
      instance.serviceAreaProgress.map((entry) => [entry.areaId, entry.status])
    );
  }

  test("full clean: detected rooms become operating, left rooms completed", () => {
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();
    expect(instance.serviceAreaCurrentArea).toBeNull();

    sight(harness, 42, "Køkken", 0);
    expect(instance.serviceAreaCurrentArea).toBe(kitchen);
    expect(progressById(instance)).toEqual({ [kitchen]: 1, [living]: 0 });

    // Still in the kitchen two minutes later. A dwell that long is a clean,
    // not a crossing, and it is what earns the room its Completed when the
    // robot moves on.
    sight(harness, 42, "Køkken", 60_000);
    sight(harness, 42, "Køkken", 60_000);
    expect(progressById(instance)).toEqual({ [kitchen]: 1, [living]: 0 });

    sight(harness, 7, "Stue", 10_000);
    expect(instance.serviceAreaCurrentArea).toBe(living);
    // The kitchen was actually cleaned, so it honestly completes.
    expect(progressById(instance)).toEqual({ [kitchen]: 3, [living]: 1 });

    const cluster = instance.buildServiceAreaCluster();
    expect(cluster.currentArea).toBe(living);
  });

  test("driving through a room is not cleaning it", () => {
    // Reported by vp-debug12 in #9: "if it passes through one room to reach
    // another one it is scheduled to clean first ... it marks that room as
    // cleaned."
    //
    // Before the dwell rule a room joined the confirmed set on its FIRST
    // detection, and a confirmed room reports Completed the moment the robot
    // moves on. So one reading taken while crossing the kitchen was enough to
    // call the kitchen done.
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();

    // Caught mid-crossing, once.
    sight(harness, 42, "Køkken", 0);
    expect(instance.serviceAreaCurrentArea).toBe(kitchen);

    // And gone again by the next reading.
    sight(harness, 7, "Stue", 10_000);

    // The kitchen must NOT claim to be cleaned. Pending is the honest answer:
    // it is still in the run's scope and still owed a visit.
    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });
  });

  test("a room crossed, then genuinely cleaned later, still completes", () => {
    // The dwell rule must not permanently disqualify a room just because the
    // robot passed through it early. Confirmation is about the current visit.
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();

    sight(harness, 42, "Køkken", 0);
    sight(harness, 7, "Stue", 10_000);
    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });

    // Back to the kitchen, and this time it stays long enough to be a clean.
    sight(harness, 42, "Køkken", 10_000);
    sight(harness, 42, "Køkken", 95_000);
    sight(harness, 7, "Stue", 10_000);

    expect(progressById(instance)).toEqual({ [kitchen]: 3, [living]: 1 });
  });

  test("a slow crossing that outlasts two readings is still not a clean", () => {
    // vp-debug12, #9, after 3.19.7 shipped the two-reading rule: "I'm still
    // having the same problem. I don't know if it's because it takes longer
    // than expected to move across the area."
    //
    // He was right. Readings are 10 seconds apart, so 2 of them span about as
    // long as walking through a room takes. The gate was the same order of
    // magnitude as the thing it was filtering, so it filtered nothing.
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();

    // Three distinct sightings spanning 20 seconds: comfortably enough to
    // satisfy "seen twice in a row", nowhere near long enough to be a clean.
    sight(harness, 42, "Køkken", 0);
    sight(harness, 42, "Køkken", 10_000);
    sight(harness, 42, "Køkken", 10_000);

    sight(harness, 7, "Stue", 10_000);

    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });
  });

  test("one position sample read by two publish cycles is one sighting", () => {
    // This method runs from the 15-second poll, the 60-second heartbeat and
    // every pushed cloud message, while the live room is refetched at most
    // every 10 seconds. So two calls can read the SAME sample — and counting
    // calls rather than observations let a single sighting confirm a room.
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();

    // One sample, observed once...
    sight(harness, 42, "Køkken", 0);
    // ...and re-read four times by later publish cycles. The clock is not
    // advanced and the live room is not re-set: nothing new was observed.
    instance.applyLiveServiceAreaRoom(RUNNING);
    instance.applyLiveServiceAreaRoom(RUNNING);
    instance.applyLiveServiceAreaRoom(RUNNING);
    instance.applyLiveServiceAreaRoom(RUNNING);

    sight(harness, 7, "Stue", 10_000);

    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });
  });

  test("dwell is not accumulated across separate passes through a room", () => {
    // Two crossings of the hall do not add up to cleaning the hall. A visit
    // ends when the robot leaves, so time never carries over.
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();

    // First pass: 60 seconds. Second pass: another 60. Together they clear the
    // 90-second dwell; separately neither does, and separately is the truth.
    sight(harness, 42, "Køkken", 0);
    sight(harness, 42, "Køkken", 60_000);
    sight(harness, 7, "Stue", 10_000);
    sight(harness, 42, "Køkken", 10_000);
    sight(harness, 42, "Køkken", 60_000);
    sight(harness, 7, "Stue", 10_000);

    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });
  });

  test("a room that missed the dwell still completes when the run ends", () => {
    // The safe direction, and the reason under-confirming is the right way to
    // be wrong: a genuinely cleaned room that fell short of the dwell shows
    // Pending mid-run, and the end of the run corrects it. Reporting a clean
    // that did not happen has no such correction.
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();

    sight(harness, 42, "Køkken", 0);
    sight(harness, 7, "Stue", 10_000);
    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });

    instance.completeServiceAreaProgressIfDone(DOCKED);
    expect(progressById(instance)).toEqual({ [kitchen]: 3, [living]: 3 });
  });

  test("room clean: the initial first-room guess falls back to pending, not completed", () => {
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    // Matter room clean of both rooms: the kitchen is only a GUESS.
    instance.beginServiceAreaProgress([kitchen, living]);
    expect(progressById(instance)).toEqual({ [kitchen]: 1, [living]: 0 });

    // First live detection says the robot actually started in the living room.
    setLiveRoom(harness, 7, "Stue");
    instance.applyLiveServiceAreaRoom(RUNNING);
    expect(instance.serviceAreaCurrentArea).toBe(living);
    // Never-visited kitchen returns to pending instead of claiming a clean.
    expect(progressById(instance)).toEqual({ [kitchen]: 0, [living]: 1 });
  });

  test("a room outside the announced scope updates currentArea but not progress", () => {
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginServiceAreaProgress([kitchen]);
    setLiveRoom(harness, 7, "Stue");
    instance.applyLiveServiceAreaRoom(RUNNING);

    expect(instance.serviceAreaCurrentArea).toBe(living);
    expect(progressById(instance)).toEqual({ [kitchen]: 1 });
  });

  test("stale all-completed progress from a finished run is never mutated", () => {
    const harness = createAccessory();
    const { instance, areaBySegment } = harness;
    const kitchen = areaBySegment.get(42);
    const living = areaBySegment.get(7);

    instance.beginFullCleanServiceAreaProgress();
    instance.completeServiceAreaProgressIfDone(DOCKED);
    expect(progressById(instance)).toEqual({ [kitchen]: 3, [living]: 3 });

    // A new app-started run begins; the old scope must not be rewritten.
    setLiveRoom(harness, 42, "Køkken");
    instance.applyLiveServiceAreaRoom(RUNNING);
    expect(instance.serviceAreaCurrentArea).toBe(kitchen);
    expect(progressById(instance)).toEqual({ [kitchen]: 3, [living]: 3 });
  });

  test("does nothing outside a cleaning run or without live data", () => {
    const harness = createAccessory();
    const { instance } = harness;

    instance.beginFullCleanServiceAreaProgress();
    setLiveRoom(harness, 42, "Køkken");
    instance.applyLiveServiceAreaRoom(DOCKED);
    expect(instance.serviceAreaCurrentArea).toBeNull();

    setLiveRoom(harness, null);
    instance.applyLiveServiceAreaRoom(RUNNING);
    expect(instance.serviceAreaCurrentArea).toBeNull();

    // An unknown segment id (room deleted from the map) is ignored.
    setLiveRoom(harness, 99, "Ghost Room");
    instance.applyLiveServiceAreaRoom(RUNNING);
    expect(instance.serviceAreaCurrentArea).toBeNull();
  });
});
