const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RRMapParser = require("../roborockLib/lib/RRMapParser");
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
// Synthetic classic RRMap builder (the format get_map_v1 returns after the
// transport layer has decrypted and gunzipped the protocol 301 payload).
// ---------------------------------------------------------------------------

// IMAGE block: 28-byte header (type, hlength, length, segment count, top,
// left, height, width) followed by one byte per pixel.
function buildImageBlock({ top, left, width, height, pixelBytes }) {
  const header = Buffer.alloc(28);
  header.writeUInt16LE(2, 0); // type IMAGE
  header.writeUInt16LE(28, 2); // hlength
  header.writeUInt32LE(pixelBytes.length, 4); // length
  header.writeUInt32LE(0, 8); // segment count hint (ids derived from pixels)
  header.writeInt32LE(top, 12);
  header.writeInt32LE(left, 16);
  header.writeInt32LE(height, 20);
  header.writeInt32LE(width, 24);
  return Buffer.concat([header, Buffer.from(pixelBytes)]);
}

// ROBOT_POSITION block: 8-byte header + x, y (mm) + angle (gen3+ layout).
function buildRobotPositionBlock(xMm, yMm) {
  const block = Buffer.alloc(8 + 12);
  block.writeUInt16LE(8, 0); // type ROBOT_POSITION
  block.writeUInt16LE(8, 2); // hlength
  block.writeUInt32LE(12, 4); // length (x, y, angle)
  block.writeInt32LE(xMm, 8);
  block.writeInt32LE(yMm, 12);
  block.writeInt32LE(90, 16); // angle
  return block;
}

function buildRRMap(blocks) {
  const body = Buffer.concat(blocks);
  const header = Buffer.alloc(20);
  header[0] = 0x72; // 'r'
  header[1] = 0x72; // 'r'
  header.writeUInt16LE(20, 2); // header length
  header.writeUInt32LE(20 + body.length, 4); // data length
  header.writeUInt16LE(1, 8); // version major
  header.writeUInt16LE(0, 10); // version minor
  header.writeUInt32LE(7, 12); // map index (non-zero)
  header.writeUInt32LE(1, 16); // map sequence
  const withoutDigest = Buffer.concat([header, body]);
  const digest = crypto.createHash("sha1").update(withoutDigest).digest();
  return Buffer.concat([withoutDigest, digest]);
}

// A 10x10 pixel map at position (top=200, left=100): segment 16 fills the
// left half, segment 17 the right half, with a segment-free column at x=4.
// Pixel byte layout: low 3 bits = pixel type (255 & 7 = 7 -> floor), bits
// 3..7 = segment id (id << 3).
const WIDTH = 10;
const HEIGHT = 10;
const TOP = 200;
const LEFT = 100;

function buildPixels() {
  const pixels = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (x === 4) {
        pixels.push(0x07); // floor, no segment
      } else if (x < 4) {
        pixels.push((16 << 3) | 0x07); // segment 16
      } else {
        pixels.push((17 << 3) | 0x07); // segment 17
      }
    }
  }
  return pixels;
}

// World mm for the center of pixel (px, py) in map coordinates.
function pixelToMm(px, py) {
  return [(LEFT + px) * 50 + 25, (TOP + py) * 50 + 25];
}

function buildMapWithRobotAt(px, py) {
  const [x, y] = pixelToMm(px, py);
  return buildRRMap([
    buildImageBlock({
      top: TOP,
      left: LEFT,
      width: WIDTH,
      height: HEIGHT,
      pixelBytes: buildPixels(),
    }),
    buildRobotPositionBlock(x, y),
  ]);
}

const parserAdapter = { log: createLog() };

describe("classic RRMap live segment resolution", () => {
  test("parses a synthetic RRMap and resolves the robot's segment", async () => {
    const parser = new RRMapParser(parserAdapter);

    const inLeftRoom = await parser.parsedata(buildMapWithRobotAt(2, 5));
    expect(inLeftRoom.ROBOT_POSITION.position).toEqual(pixelToMm(2, 5));
    expect(RRMapParser.resolveLiveSegmentId(inLeftRoom)).toBe(16);

    const inRightRoom = await parser.parsedata(buildMapWithRobotAt(7, 3));
    expect(RRMapParser.resolveLiveSegmentId(inRightRoom)).toBe(17);
  });

  test("returns null on segment-free pixels, outside the image, and missing data", async () => {
    const parser = new RRMapParser(parserAdapter);

    const onCorridor = await parser.parsedata(buildMapWithRobotAt(4, 4));
    expect(RRMapParser.resolveLiveSegmentId(onCorridor)).toBeNull();

    const outside = await parser.parsedata(
      buildRRMap([
        buildImageBlock({
          top: TOP,
          left: LEFT,
          width: WIDTH,
          height: HEIGHT,
          pixelBytes: buildPixels(),
        }),
        buildRobotPositionBlock(0, 0), // far outside the image
      ])
    );
    expect(RRMapParser.resolveLiveSegmentId(outside)).toBeNull();

    expect(RRMapParser.resolveLiveSegmentId({})).toBeNull();
    expect(RRMapParser.resolveLiveSegmentId(null)).toBeNull();
  });
});

describe("fast buffer path (resolveLiveSegmentFromMapBuffer)", () => {
  test("matches the parsedata-based resolution for every probe position", async () => {
    const parser = new RRMapParser(parserAdapter);
    const probes = [
      [2, 5],
      [7, 3],
      [4, 4], // segment-free corridor
      [0, 0],
      [9, 9],
      [3, 8],
    ];
    for (const [px, py] of probes) {
      const map = buildMapWithRobotAt(px, py);
      const slow = RRMapParser.resolveLiveSegmentId(
        await parser.parsedata(map)
      );
      const fast = RRMapParser.resolveLiveSegmentFromMapBuffer(map);
      expect(fast).toBe(slow);
    }
  });

  test("rejects malformed buffers without throwing", () => {
    expect(RRMapParser.resolveLiveSegmentFromMapBuffer(null)).toBeNull();
    expect(
      RRMapParser.resolveLiveSegmentFromMapBuffer(Buffer.from("not a map"))
    ).toBeNull();
    expect(
      RRMapParser.resolveLiveSegmentFromMapBuffer(Buffer.alloc(0))
    ).toBeNull();
    // Valid magic but truncated body.
    const truncated = buildMapWithRobotAt(2, 5).subarray(0, 40);
    expect(RRMapParser.resolveLiveSegmentFromMapBuffer(truncated)).toBeNull();
  });

  test("robot position outside the image resolves to null", () => {
    const map = buildRRMap([
      buildImageBlock({
        top: TOP,
        left: LEFT,
        width: WIDTH,
        height: HEIGHT,
        pixelBytes: buildPixels(),
      }),
      buildRobotPositionBlock(0, 0),
    ]);
    expect(RRMapParser.resolveLiveSegmentFromMapBuffer(map)).toBeNull();
  });
});

describe("refreshClassicLiveRoom", () => {
  function createApi(options = {}) {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "classic-live-")),
      ...options,
    });
    api.vacuums["duid-s8"] = {};
    api.getVacuumDeviceInfo = jest.fn(() => ""); // classic (not B01)
    api.getRoomMappingsForDevice = jest.fn(() => [
      { segmentId: 16, mapId: 0, name: "Køkken" },
      { segmentId: 17, mapId: 0, name: "Stue" },
    ]);
    api.__map = buildMapWithRobotAt(2, 5); // segment 16
    api.messageQueueHandler = {
      sendRequest: jest.fn(async (duid, method, params, secure) => {
        if (method !== "get_map_v1" || secure !== true) {
          throw new Error(`unexpected request ${method} secure=${secure}`);
        }
        return api.__map;
      }),
    };
    return api;
  }

  test("fetches the map securely, resolves the room, and re-broadcasts on change", async () => {
    const api = createApi();
    const notify = jest.fn();
    api.setDeviceNotify(notify);

    const result = await api.refreshLiveRoomForDevice("duid-s8", {
      v1State: 5,
    });
    expect(result).toMatchObject({ segmentId: 16, roomName: "Køkken" });
    expect(api.getLiveRoomForDevice("duid-s8")).toMatchObject({
      segmentId: 16,
    });
    expect(notify).toHaveBeenCalledWith("CloudMessage", {
      duid: "duid-s8",
      payload: [{ state: 5 }],
    });

    // Throttled: an immediate second call does not fetch again.
    await api.refreshLiveRoomForDevice("duid-s8", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);

    // Robot moves to the right room: change detected after the gap.
    api.__map = buildMapWithRobotAt(7, 3); // segment 17
    api._classicLiveRoomState.get("duid-s8").lastAttemptAt = Date.now() - 21000;
    const moved = await api.refreshLiveRoomForDevice("duid-s8", {
      v1State: 5,
    });
    expect(moved).toMatchObject({ segmentId: 17, roomName: "Stue" });
    expect(notify).toHaveBeenCalledTimes(2);

    api.clearLiveRoomForDevice("duid-s8");
    expect(api.getLiveRoomForDevice("duid-s8")).toBeNull();
  });

  test("skips fetching for states where the robot cannot change rooms", async () => {
    const api = createApi();
    await api.refreshClassicLiveRoom("duid-s8", { v1State: 8 }); // charging
    await api.refreshClassicLiveRoom("duid-s8", { v1State: 10 }); // paused
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });

  test("keeps the previous room when the robot answers with a non-map payload", async () => {
    const api = createApi();
    api.setDeviceNotify(jest.fn());
    await api.refreshLiveRoomForDevice("duid-s8", { v1State: 5 });

    api.__map = "retry"; // robot busy answer instead of a map buffer
    api._classicLiveRoomState.get("duid-s8").lastAttemptAt = Date.now() - 21000;
    const retained = await api.refreshLiveRoomForDevice("duid-s8", {
      v1State: 5,
    });
    expect(retained).toMatchObject({ segmentId: 16 });
  });

  test("does nothing when live room tracking is disabled", async () => {
    const api = createApi({ enableLiveRoomTracking: false });
    const result = await api.refreshLiveRoomForDevice("duid-s8", {
      v1State: 5,
    });
    expect(result).toBeNull();
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });
});
