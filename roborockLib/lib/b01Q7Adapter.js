"use strict";

const crypto = require("crypto");
const zlib = require("zlib");

/**
 * B01/Q7 protocol adapter.
 *
 * Roborock's 2025 Q-series (Q7 M5 `roborock.vacuum.sc05`, Q7 M5+ `ss07`, ...)
 * speak the "B01" protocol dialect: same 23-byte Roborock framing and
 * AES-128-CBC payload encryption, but a completely different RPC surface.
 * Requests carry a single JSON object on dps 10000:
 *
 *   {"dps":{"10000":{"method":"prop.get","msgId":"200000000001","params":{...}}}}
 *
 * and responses arrive on dps 10001 as a JSON *string*:
 *
 *   {"t":...,"dps":{"10001":"{\"msgId\":\"200000000001\",\"code\":0,
 *                             \"method\":\"prop.get\",\"data\":{...}}"}}
 *
 * Correlation is by `msgId` (a 12-digit decimal string), success is
 * `code === 0`, and the classic v1 methods (app_start, get_status, ...) do
 * not exist. This module translates between the plugin's v1-shaped command
 * surface and the Q7 dialect so the rest of the plugin — including the
 * whole Matter layer — runs unchanged.
 *
 * Method names, parameter shapes, enum codes, and the response format are
 * taken from the actively maintained python-roborock reference
 * implementation (roborock/devices/traits/b01/q7, b01_q7_protocol.py,
 * b01_q7_code_mappings.py) and its recorded protocol fixtures.
 */

const B01_PROTOCOL_VERSION = "B01";

// Why a B01 robot is routed over the Roborock cloud. The dialect has no LAN
// request surface at all, so these robots are marked remote at startup and the
// plugin never opens a local TCP socket to them. That is a property of the
// protocol, not a fault, and the diagnostic report has to say so: labelling it
// as a failed LAN connection sends users hunting a network problem that cannot
// exist. Both the transport layer and the UI server read this one constant so
// the two sides cannot drift apart.
const B01_CLOUD_ONLY_REMOTE_REASON = "b01-protocol-cloud-only";

// Q7 properties queried for a status snapshot (RoborockB01Props).
// Note: no "water" property. Q7-series robots use a manually filled water
// tank on the robot with no electronic water level/control, so water state
// is neither queried nor exposed (see also getMatterCleanModeCapabilities).
const B01_STATUS_PROPS = ["status", "quantity", "fault", "wind", "mode"];

// Matter RVC clean modes (Vacuum=0, Mop=1, Vacuum+Mop=2) -> Q7 `mode`
// property values (CleanTypeMapping: VACUUM=0, VAC_AND_MOP=1, MOP=2).
// Note the crossed values: Matter's Mop is Q7's 2, Matter's combo is Q7's 1.
/** @type {Record<number, number>} */
const MATTER_TO_Q7_CLEAN_TYPE = { 0: 0, 1: 2, 2: 1 };
// Inverse direction: the Q7 reports its ACTIVE clean type in the same `mode`
// property on every status poll, so cleans started from the Roborock app (or
// the robot's buttons) can be reflected truthfully in Matter controllers.
/** @type {Record<number, number>} */
const Q7_CLEAN_TYPE_TO_MATTER = { 0: 0, 1: 2, 2: 1 };

// service.set_room_clean control values (SCDeviceCleanParam).
const CTRL = { STOP: 0, START: 1, PAUSE: 2 };
// service.set_room_clean clean task types (CleanTaskTypeMapping).
const CLEAN_TASK = { ALL: 0, ROOM: 1 };

// Q7 `wind` (suction) codes <-> v1 fan_power codes.
/** @type {Record<number, number>} */
const WIND_TO_V1_FAN_POWER = { 1: 101, 2: 102, 3: 103, 4: 104, 5: 108 };
/** @type {Record<number, number>} */
const V1_FAN_POWER_TO_WIND = {
  101: 1, // quiet
  102: 2, // balanced
  103: 3, // turbo
  104: 4, // max
  108: 5, // max+
  105: 1, // "off" has no Q7 equivalent; degrade to quiet
  106: 2, // custom -> balanced
};

/**
 * Q7 WorkStatusMapping -> the plugin's universal v1 state codes, which the
 * Matter layer (and the charging/docked tile logic) already understands.
 *
 *   0 sleeping            -> 3   Idle
 *   1 waiting_for_orders  -> 3   Idle
 *   2 paused              -> 10  Paused
 *   3 docking             -> 15  Docking (Matter: Seeking Charger)
 *   4 charging            -> 8   Charging
 *   5 sweep_moping        -> 5   Cleaning
 *   6 sweep_moping_2      -> 5   Cleaning
 *   7 moping              -> 5   Cleaning
 *   8 updating            -> 3   Idle
 *   9 mop_cleaning        -> 23  Washing the mop
 *  10 mop_airdrying       -> 8   Charging/docked (battery threshold decides tile)
 */
// Q7 fault codes that are informational rather than active errors (B01Fault
// in the reference: 407 = "Cleaning in progress. Scheduled cleanup ignored").
const INFORMATIONAL_B01_FAULTS = new Set([0, 407]);

/** @type {Record<number, number>} */
const B01_STATUS_TO_V1_STATE = {
  0: 3,
  1: 3,
  2: 10,
  3: 15,
  4: 8,
  5: 5,
  6: 5,
  7: 5,
  8: 3,
  9: 23,
  10: 8,
};

/** @param {unknown} version */
/**
 * Derive the B01/Q7 map decrypt key from serial + model
 * (reference: python-roborock create_map_key).
 * key = md5hex(base64(AES-128-ECB(sn+"+"+suffix+"+"+sn, key=(suffix+"0"*16)[:16])))[8:24]
 * @param {string} serial
 * @param {string} model
 * @returns {Buffer}
 */
function createMapKey(serial, model) {
  const modelSuffix = String(model).split(".").pop() || "";
  const modelKey = Buffer.from((modelSuffix + "0".repeat(16)).slice(0, 16));
  const material = Buffer.from(`${serial}+${modelSuffix}+${serial}`);

  const cipher = crypto.createCipheriv("aes-128-ecb", modelKey, null);
  const encrypted = Buffer.concat([cipher.update(material), cipher.final()]);
  const md5 = crypto
    .createHash("md5")
    .update(encrypted.toString("base64"))
    .digest("hex");
  return Buffer.from(md5.slice(8, 24));
}

/**
 * Decode a raw B01 MAP_RESPONSE payload into inflated SCMap protobuf bytes:
 * base64 -> AES-128-ECB decrypt -> ascii hex -> bytes -> zlib inflate.
 * @param {Buffer} rawPayload
 * @param {Buffer} mapKey
 * @returns {Buffer}
 */
function decodeMapPayload(rawPayload, mapKey) {
  const blob = rawPayload.toString("ascii").trim();
  const padded = blob + "=".repeat((4 - (blob.length % 4)) % 4);
  const encrypted = Buffer.from(padded, "base64");

  if (encrypted.length % 16 !== 0) {
    throw new Error(
      `Unexpected encrypted B01 map payload length: ${encrypted.length}`
    );
  }

  const decipher = crypto.createDecipheriv("aes-128-ecb", mapKey, null);
  const compressedHex = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("ascii");
  const compressed = Buffer.from(compressedHex, "hex");
  return zlib.inflateSync(compressed);
}

/**
 * Shared minimal protobuf wire readers for the SCMap RobotMap payload.
 * Reference schema: b01_scmap.proto (fields 5-11/13-22 documented in the
 * wider CRL-200S family schema used by ioBroker.roborock).
 */

/** @param {Buffer} buf @param {number} pos */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) {
      return { value: result, pos };
    }
    shift += 7;
    if (shift > 63) break;
  }
  throw new Error("Malformed varint in SCMap payload");
}

// Bounds for the raw field survey below. They exist to keep a diagnostic
// from becoming a liability: the survey is pointed at fields whose schema is
// unknown, so it must not be able to produce an unbounded log line, walk the
// occupancy grid as if it were protobuf, or recurse without end.
const RAW_SURVEY_MAX_SCALARS = 48;
const RAW_SURVEY_MAX_SUBMESSAGE_BYTES = 16384;
const RAW_SURVEY_MAX_DEPTH = 2;

/** @param {Buffer} buf @param {number} pos @param {number} wireType */
function skipField(buf, pos, wireType) {
  switch (wireType) {
    case 0:
      return readVarint(buf, pos).pos;
    case 1:
      return pos + 8;
    case 2: {
      const len = readVarint(buf, pos);
      return len.pos + len.value;
    }
    case 5:
      return pos + 4;
    default:
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }
}

/**
 * Minimal protobuf wire reader extracting rooms from SCMap RobotMap bytes.
 * Only RobotMap field 12 (repeated RoomDataInfo) is decoded, and inside it
 * only roomId (field 1, varint) and roomName (field 2, string); every other
 * field is skipped by wire type. Reference schema: b01_scmap.proto.
 * @param {Buffer} buffer
 * @returns {Array<{roomId: number, roomName: string}>}
 */
function parseRoomsFromScMap(buffer) {
  /** @type {Array<{roomId: number, roomName: string}>} */
  const rooms = [];

  /** @param {Buffer} buf */
  function parseRoom(buf) {
    /** @type {{roomId: number, roomName: string}} */
    const room = { roomId: -1, roomName: "" };
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;

      if (fieldNumber === 1 && wireType === 0) {
        const value = readVarint(buf, pos);
        room.roomId = value.value;
        pos = value.pos;
      } else if (fieldNumber === 2 && wireType === 2) {
        const len = readVarint(buf, pos);
        room.roomName = buf
          .subarray(len.pos, len.pos + len.value)
          .toString("utf8");
        pos = len.pos + len.value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
    return room;
  }

  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    pos = tag.pos;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;

    if (fieldNumber === 12 && wireType === 2) {
      const len = readVarint(buffer, pos);
      const room = parseRoom(buffer.subarray(len.pos, len.pos + len.value));
      if (room.roomId >= 0) {
        rooms.push(room);
      }
      pos = len.pos + len.value;
    } else {
      pos = skipField(buffer, pos, wireType);
    }
  }

  return rooms;
}

/**
 * Parse the SCMap RobotMap fields needed to derive the robot's live room:
 * map head (field 3: grid geometry), current pose (field 8: world-coordinate
 * robot position in meters) and room outline chains (field 14: per-room
 * boundary contours in grid-cell coordinates). Room names come from field 12
 * via the same reader as parseRoomsFromScMap. Every other field is skipped.
 *
 * Wire reference (proto2, CRL-200S family / ioBroker.roborock schema):
 * - MapHeadInfo:            sizeX=1 varint, sizeY=2 varint, minX=4 float,
 *                           minY=5 float, resolution=8 float
 * - DeviceCurrentPoseInfo:  poseId=1 varint, update=2 varint,
 *                           x=3 float, y=4 float, phi=5 float
 * - DeviceRoomChainDataInfo: roomId=1 varint,
 *                            points=2 repeated {x=1 varint, y=2 varint}
 * @param {Buffer} buffer
 * @returns {{
 *   head: {sizeX: number, sizeY: number, minX: number, minY: number, resolution: number} | null,
 *   pose: {x: number, y: number} | null,
 *   rawSurvey: {
 *     fields: Array<{field: number, count: number, bytes: number}>,
 *     scalars: Record<string, number>,
 *     truncated: boolean,
 *   },
 *   rooms: Array<{roomId: number, roomName: string}>,
 *   roomChains: Array<{roomId: number, points: Array<{x: number, y: number}>}>,
 * }}
 */
function parseScMapLiveState(buffer) {
  /** @type {{sizeX: number, sizeY: number, minX: number, minY: number, resolution: number} | null} */
  let head = null;
  /** @type {{x: number, y: number} | null} */
  let pose = null;
  // Diagnostic. Both Q7s in the field reported a pose of exactly
  // (1100.0, 1100.0) — the same value on two robots, two maps and twelve
  // minutes of active cleaning. That is a constant, not a position, so the
  // number being read as the robot's position is not the robot's position.
  //
  // The schema above is not obviously wrong, which is what makes guessing
  // another field number a bad move: it would be the third guess in a row on
  // this code path. Two candidates fit the evidence and the survey separates
  // them without a second release. DeviceCurrentPoseInfo carries an `update`
  // varint, so field 8 may simply be marked stale on this firmware — a
  // float-only dump would not have shown it. And field 6 is a pose *trail*,
  // whose last point is by construction where the robot is now — which needs
  // one level of nesting to see. So the survey records varints as well as
  // floats, and descends one level: repeated paths overwrite, which leaves
  // the last point of a trail sitting in the log under a stable key.
  /** @type {Array<{field: number, count: number, bytes: number}>} */
  const surveyFields = [];
  /** @type {Record<string, number>} */
  const surveyScalars = {};
  let surveyTruncated = false;
  /** @type {Array<{roomId: number, roomChainPoints?: unknown}>} */
  const roomChains = [];

  /** @param {Buffer} buf */
  function parseMapHead(buf) {
    const parsed = { sizeX: 0, sizeY: 0, minX: 0, minY: 0, resolution: 0.05 };
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (wireType === 0) {
        const value = readVarint(buf, pos);
        pos = value.pos;
        if (fieldNumber === 2) parsed.sizeX = value.value;
        else if (fieldNumber === 3) parsed.sizeY = value.value;
      } else if (wireType === 5) {
        const value = buf.readFloatLE(pos);
        pos += 4;
        if (fieldNumber === 4) parsed.minX = value;
        else if (fieldNumber === 5) parsed.minY = value;
        else if (fieldNumber === 8 && value > 0) parsed.resolution = value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
    return parsed;
  }

  /** @param {Buffer} buf */
  function parseCurrentPose(buf) {
    /** @type {{x: number | null, y: number | null}} */
    const parsed = { x: null, y: null };
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (wireType === 5) {
        const value = buf.readFloatLE(pos);
        pos += 4;
        if (fieldNumber === 3) parsed.x = value;
        else if (fieldNumber === 4) parsed.y = value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
    return parsed.x !== null && parsed.y !== null
      ? { x: parsed.x, y: parsed.y }
      : null;
  }

  /**
   * Record that a top-level field was seen, and how many bytes it carried.
   *
   * The sizes matter as much as the values: a submessage that grows between
   * two consecutive log lines while the robot is driving is a trail of where
   * it has been, and the field that does that is the one worth reading.
   *
   * @param {number} field
   * @param {number} bytes
   */
  function noteField(field, bytes) {
    const seen = surveyFields.find((entry) => entry.field === field);
    if (seen) {
      seen.count += 1;
      seen.bytes += bytes;
    } else if (surveyFields.length < RAW_SURVEY_MAX_SCALARS) {
      surveyFields.push({ field, count: 1, bytes });
    } else {
      surveyTruncated = true;
    }
  }

  /**
   * @param {string} path
   * @param {number} value
   */
  function noteScalar(path, value) {
    if (
      surveyScalars[path] === undefined &&
      Object.keys(surveyScalars).length >= RAW_SURVEY_MAX_SCALARS
    ) {
      surveyTruncated = true;
      return;
    }
    // Deliberately last-wins. A repeated submessage collapses to its final
    // occurrence, which for a pose trail is the current position.
    surveyScalars[path] = value;
  }

  /**
   * Walk a submessage recording every scalar it contains, keyed by dotted
   * field path, to a bounded depth.
   *
   * Diagnostic only, and defensive by necessity: it is pointed at fields
   * whose schema is unknown, so bytes that are not protobuf at all will
   * reach it. A throw here would take live-room tracking down with it, so
   * the caller swallows the error and keeps whatever was collected.
   *
   * @param {Buffer} buf
   * @param {string} prefix
   * @param {number} depth
   */
  function surveyMessage(buf, prefix, depth) {
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      const path = `${prefix}.${fieldNumber}`;
      if (wireType === 0) {
        const value = readVarint(buf, pos);
        pos = value.pos;
        noteScalar(path, value.value);
      } else if (wireType === 5) {
        noteScalar(path, buf.readFloatLE(pos));
        pos += 4;
      } else if (wireType === 1) {
        noteScalar(path, buf.readDoubleLE(pos));
        pos += 8;
      } else if (wireType === 2) {
        const len = readVarint(buf, pos);
        if (depth > 1 && len.value > 0) {
          surveyMessage(
            buf.subarray(len.pos, len.pos + len.value),
            path,
            depth - 1
          );
        }
        pos = len.pos + len.value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
  }

  /**
   * @param {Buffer} buf
   * @param {number} field
   */
  function surveyTopLevelSubmessage(buf, field) {
    if (buf.length > RAW_SURVEY_MAX_SUBMESSAGE_BYTES) {
      // The occupancy grid is tens of kilobytes of raw cells, not protobuf.
      // Its size is recorded; walking it would be nonsense and slow.
      return;
    }
    try {
      surveyMessage(buf, String(field), RAW_SURVEY_MAX_DEPTH);
    } catch {
      surveyTruncated = true;
    }
  }

  /** @param {Buffer} buf */
  function parseChainPoint(buf) {
    const point = { x: 0, y: 0 };
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (wireType === 0) {
        const value = readVarint(buf, pos);
        pos = value.pos;
        if (fieldNumber === 1) point.x = value.value;
        else if (fieldNumber === 2) point.y = value.value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
    return point;
  }

  /** @param {Buffer} buf */
  function parseRoomChain(buf) {
    /** @type {{roomId: number, points: Array<{x: number, y: number}>}} */
    const chain = { roomId: -1, points: [] };
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (fieldNumber === 1 && wireType === 0) {
        const value = readVarint(buf, pos);
        chain.roomId = value.value;
        pos = value.pos;
      } else if (fieldNumber === 2 && wireType === 2) {
        const len = readVarint(buf, pos);
        chain.points.push(
          parseChainPoint(buf.subarray(len.pos, len.pos + len.value))
        );
        pos = len.pos + len.value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
    return chain;
  }

  /** @param {Buffer} buf */
  function parseRoomEntry(buf) {
    const room = { roomId: -1, roomName: "" };
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (fieldNumber === 1 && wireType === 0) {
        const value = readVarint(buf, pos);
        room.roomId = value.value;
        pos = value.pos;
      } else if (fieldNumber === 2 && wireType === 2) {
        const len = readVarint(buf, pos);
        room.roomName = buf
          .subarray(len.pos, len.pos + len.value)
          .toString("utf8");
        pos = len.pos + len.value;
      } else {
        pos = skipField(buf, pos, wireType);
      }
    }
    return room;
  }

  /** @type {Array<{roomId: number, roomName: string}>} */
  const rooms = [];

  // Single pass over the RobotMap wire format: head, pose, rooms and room
  // chains are all collected in one walk instead of delegating rooms to a
  // second parseRoomsFromScMap scan. Measured honestly: the win is
  // negligible (~0.05 ms either way — skipField jumps the large grid field
  // via its length prefix without touching bytes); this is kept for the
  // simpler single-walk structure, not for speed.
  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    pos = tag.pos;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;

    if (wireType === 2) {
      const len = readVarint(buffer, pos);
      const body = buffer.subarray(len.pos, len.pos + len.value);
      noteField(fieldNumber, len.value);
      surveyTopLevelSubmessage(body, fieldNumber);
      if (fieldNumber === 3) {
        head = parseMapHead(body);
      } else if (fieldNumber === 8) {
        pose = parseCurrentPose(body);
      } else if (fieldNumber === 12) {
        const room = parseRoomEntry(body);
        if (room.roomId >= 0) {
          rooms.push(room);
        }
      } else if (fieldNumber === 14) {
        const chain = parseRoomChain(body);
        if (chain.roomId >= 0 && chain.points.length >= 3) {
          roomChains.push(chain);
        }
      }
      pos = len.pos + len.value;
    } else {
      // A position could just as easily be a bare float or varint on the
      // RobotMap itself; the loop above only ever looked at submessages, so
      // such a field would never have been seen at all.
      noteField(fieldNumber, 0);
      if (wireType === 0) {
        noteScalar(String(fieldNumber), readVarint(buffer, pos).value);
      } else if (wireType === 5) {
        noteScalar(String(fieldNumber), buffer.readFloatLE(pos));
      } else if (wireType === 1) {
        noteScalar(String(fieldNumber), buffer.readDoubleLE(pos));
      }
      pos = skipField(buffer, pos, wireType);
    }
  }

  return {
    head,
    pose,
    rawSurvey: {
      fields: surveyFields,
      scalars: surveyScalars,
      truncated: surveyTruncated,
    },
    rooms,
    roomChains:
      /** @type {Array<{roomId: number, points: Array<{x: number, y: number}>}>} */ (
        roomChains
      ),
  };
}

/**
 * Resolve which room the robot is physically inside, and say WHY when it
 * cannot be resolved.
 *
 * The world-coordinate pose (meters) is converted to grid-cell coordinates —
 * `(pose - min) / resolution`, the inverse of the chain-point mapping
 * `world = min + cell * resolution` — and ray-cast against each room's
 * boundary chain.
 *
 * A bare null collapses four very different situations into one, and the log
 * line built on it asserted a single cause — "the robot's position did not
 * fall inside any known room outline". In the field a Q7 produced fifty of
 * those in a day, and there was no way to tell whether its pose was missing
 * from the payload, whether the payload carried no outlines at all, or
 * whether the point-in-polygon test genuinely rejected the position. Those
 * three call for three different fixes.
 *
 * @param {{head?: {minX: number, minY: number, resolution: number,
 *                 sizeX?: number, sizeY?: number} | null,
 *          pose?: {x: number, y: number} | null,
 *          roomChains?: Array<{roomId: number, points: Array<{x: number, y: number}>}>} | null} liveState
 * @returns {{roomId: number | null,
 *            reason: "resolved" | "no-map-header" | "no-pose" | "no-room-outlines"
 *              | "pose-outside-outlines" | "pose-placeholder",
 *            outlineCount: number,
 *            cell: {x: number, y: number} | null,
 *            outlineBounds?: {minX: number, minY: number, maxX: number, maxY: number} | null,
 *            head?: {minX: number, minY: number, resolution: number}}}
 */
function describeLiveRoomResolution(liveState) {
  const head = liveState?.head;
  const pose = liveState?.pose;
  const chains = Array.isArray(liveState?.roomChains)
    ? liveState.roomChains
    : [];
  const outlineCount = chains.length;

  if (!head) {
    return { roomId: null, reason: "no-map-header", outlineCount, cell: null };
  }
  if (!pose) {
    return { roomId: null, reason: "no-pose", outlineCount, cell: null };
  }

  const resolution = head.resolution > 0 ? head.resolution : 0.05;
  const cellX = (pose.x - head.minX) / resolution;
  const cellY = (pose.y - head.minY) / resolution;
  const cell = { x: cellX, y: cellY };

  if (!outlineCount) {
    return { roomId: null, reason: "no-room-outlines", outlineCount, cell };
  }

  for (const chain of chains) {
    if (pointInPolygon(cellX, cellY, chain.points)) {
      // The cell rides along on a hit too. Without it the log could say which
      // attempts failed and with what position, but never what a SUCCEEDING
      // position looked like — so the two could not be compared, and the
      // measurement below took a second field session to make.
      return { roomId: chain.roomId, reason: "resolved", outlineCount, cell };
    }
  }

  const outlineBounds = outlineBoundingBox(chains);

  // A pose that is not merely outside the rooms but nowhere near the map is a
  // different thing, and calling both "outside the outlines" sent every
  // investigation down the same wrong path for three weeks.
  //
  // Measured on a Q7 over a 47-minute clean, 227 fetches: 226 of them placed
  // the robot at cell 22280,22100 — the same cell every time — while the room
  // outlines spanned 38-293 x 90-227. The underlying pose was exactly
  // (1100, 1100) in every one, the same constant two other Q7s reported in
  // August. The remaining fetches resolved a real room in the right order, so
  // the robot DOES send a true pose sometimes; it just serves a placeholder in
  // between, and those are the fetches that must not be counted as the robot
  // being between rooms.
  //
  // The test is deliberately about distance rather than about the value 1100:
  // a placeholder is a position further outside the map than the map is wide,
  // which no real robot can be, and which stays true if Roborock picks a
  // different constant tomorrow.
  if (isOffTheMap(cell, head, outlineBounds)) {
    return {
      roomId: null,
      reason: "pose-placeholder",
      outlineCount,
      cell,
      outlineBounds,
      head: { minX: head.minX, minY: head.minY, resolution },
    };
  }

  return {
    roomId: null,
    reason: "pose-outside-outlines",
    outlineCount,
    cell,
    outlineBounds,
    head: { minX: head.minX, minY: head.minY, resolution },
  };
}

/**
 * Whether a cell is outside the map raster itself.
 *
 * The map's own `sizeX`/`sizeY` is the right yardstick and the outline
 * bounding box is not: outlines cover rooms, while the raster covers
 * everywhere the robot has ever been. A robot standing in a doorway, in a
 * hallway nobody named, or against a wall the outlines do not reach is
 * legitimately outside every outline and inside the map — that is a real miss
 * and must keep counting as one. Being outside the raster is not a position
 * at all; the robot cannot be somewhere it has never mapped.
 *
 * One raster width of slack on each side, because the transform can put a
 * genuine edge case a little past the boundary and this must not swallow a
 * real coordinate bug. The measured placeholder sat at cell 22280 on a map
 * 500 cells wide — 44 times out — so the margin costs nothing.
 *
 * Falls back to the outline bounds when a header carries no size, which is
 * the only case where there is nothing better to compare against.
 *
 * @param {{x: number, y: number}} cell
 * @param {{minX: number, minY: number, resolution: number,
 *          sizeX?: number, sizeY?: number}} head
 * @param {{minX: number, minY: number, maxX: number, maxY: number} | null} outlineBounds
 * @returns {boolean}
 */
function isOffTheMap(cell, head, outlineBounds) {
  const sizeX = Number(head?.sizeX) || 0;
  const sizeY = Number(head?.sizeY) || 0;

  if (sizeX > 0 && sizeY > 0) {
    return (
      cell.x < -sizeX ||
      cell.x > sizeX * 2 ||
      cell.y < -sizeY ||
      cell.y > sizeY * 2
    );
  }

  if (!outlineBounds) {
    return false;
  }

  const spanX = Math.max(outlineBounds.maxX - outlineBounds.minX, 1);
  const spanY = Math.max(outlineBounds.maxY - outlineBounds.minY, 1);

  return (
    cell.x < outlineBounds.minX - spanX * 4 ||
    cell.x > outlineBounds.maxX + spanX * 4 ||
    cell.y < outlineBounds.minY - spanY * 4 ||
    cell.y > outlineBounds.maxY + spanY * 4
  );
}

/**
 * Bounding box of every room outline, in the same cell space the
 * point-in-polygon test uses.
 *
 * Field logs showed two Q7s reporting position cells around 22,000 while a
 * Roborock map is at most a couple of thousand cells across — so the position
 * is not "between rooms", it is nowhere near the map. Whether that is a unit
 * mismatch (pose in millimetres against a resolution in metres) or a wrong
 * origin cannot be told from the position alone: it needs the range the
 * outlines actually occupy. Printing both next to each other turns a guess
 * into a measurement.
 *
 * @param {Array<{points: Array<{x: number, y: number}>}>} chains
 * @returns {{minX: number, minY: number, maxX: number, maxY: number} | null}
 */
function outlineBoundingBox(chains) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const chain of chains) {
    for (const point of chain.points || []) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Standard ray-casting point-in-polygon test over a room boundary chain.
 * @param {number} x @param {number} y
 * @param {Array<{x: number, y: number}>} points
 * @returns {boolean}
 */
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Pick the current map id from a `service.get_map_list` response
 * ({map_list: [{id, cur}]}), preferring the entry marked current.
 * @param {any} data
 * @returns {number | null}
 */
function findCurrentMapId(data) {
  const list = Array.isArray(data?.map_list) ? data.map_list : [];
  if (!list.length) {
    return null;
  }
  const current =
    list.find((/** @type {any} */ entry) => entry && entry.cur === true) ||
    list[0];
  return current && Number.isInteger(current.id) ? current.id : null;
}

const B01_MAP_UPLOAD_METHOD = "service.upload_by_mapid";

/** @param {unknown} version */
function isB01Protocol(version) {
  return version === B01_PROTOCOL_VERSION;
}

/** 12-digit decimal message id matching the observed Q7 wire format. */
function createB01MessageId() {
  return String(100000000000 + Math.floor(Math.random() * 899999999999));
}

/** @param {any} params */
function normalizeSegmentIds(params) {
  if (Array.isArray(params)) {
    if (params.length === 1 && params[0] && Array.isArray(params[0].segments)) {
      return params[0].segments.map(Number);
    }
    return params.map(Number).filter((value) => Number.isFinite(value));
  }
  if (params && Array.isArray(params.segments)) {
    return params.segments.map(Number);
  }
  return [];
}

/**
 * Translate a v1-shaped outgoing command to the Q7 dialect.
 * Returns {method, params} on success, or null when the method has no Q7
 * equivalent (callers decide between a neutral response and an error).
 * @param {string} method
 * @param {any} params
 * @returns {{method: string, params: any, kind?: string} | null}
 */
function translateOutgoing(method, params) {
  switch (method) {
    case "app_start":
      return {
        method: "service.set_room_clean",
        params: {
          clean_type: CLEAN_TASK.ALL,
          ctrl_value: CTRL.START,
          room_ids: [],
        },
      };
    case "app_stop":
      return {
        method: "service.set_room_clean",
        params: {
          clean_type: CLEAN_TASK.ALL,
          ctrl_value: CTRL.STOP,
          room_ids: [],
        },
      };
    case "app_pause":
      return {
        method: "service.set_room_clean",
        params: {
          clean_type: CLEAN_TASK.ALL,
          ctrl_value: CTRL.PAUSE,
          room_ids: [],
        },
      };
    case "app_charge":
      return { method: "service.start_recharge", params: {} };
    case "find_me":
      return { method: "service.find_device", params: {} };
    case "app_segment_clean":
    case "app_segment_clean_by_ids": {
      const roomIds = normalizeSegmentIds(params);
      return {
        method: "service.set_room_clean",
        params: {
          clean_type: CLEAN_TASK.ROOM,
          ctrl_value: CTRL.START,
          room_ids: roomIds,
        },
      };
    }
    case "set_custom_mode": {
      const v1Code = Array.isArray(params) ? params[0] : params;
      const wind = V1_FAN_POWER_TO_WIND[v1Code];
      return wind === undefined
        ? null
        : { method: "prop.set", params: { wind } };
    }
    case "set_clean_type": {
      const matterMode = Array.isArray(params) ? params[0] : params;
      const q7Mode = MATTER_TO_Q7_CLEAN_TYPE[matterMode];
      return q7Mode === undefined
        ? null
        : { method: "prop.set", params: { mode: q7Mode } };
    }
    case "set_water_box_custom_mode":
      // Q7 water is a manual tank; not exposed or controlled.
      return null;
    case "get_map_list":
      return { method: "service.get_map_list", params: {} };
    case "get_status":
      return {
        method: "prop.get",
        params: { property: [...B01_STATUS_PROPS] },
        kind: "status",
      };
    case "get_prop":
      if (Array.isArray(params) && params[0] === "get_status") {
        return {
          method: "prop.get",
          params: { property: [...B01_STATUS_PROPS] },
          kind: "status",
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Methods the plugin's periodic machinery calls that have no Q7 equivalent.
 * Returning a neutral value keeps those paths quiet instead of erroring.
 */
const NEUTRAL_RESPONSES = new Map([
  ["get_network_info", () => ({})],
  ["get_consumable", () => [{}]],
  ["get_room_mapping", () => []],
  ["get_server_timer", () => []],
  ["get_multi_maps_list", () => [{ max_multi_map: 0, map_info: [] }]],
  ["get_clean_summary", () => [0, 0, 0, []]],
  ["get_carpet_mode", () => [{}]],
  ["get_custom_mode", () => []],
]);

/** @param {string} method
 * @returns {{value: any} | undefined} */
function neutralResponse(method) {
  const factory = NEUTRAL_RESPONSES.get(method);
  return factory ? { value: factory() } : undefined;
}

/**
 * True when a v1-shaped request has *any* answer on a Q7 robot — a real
 * translation or a neutral placeholder. Everything else is rejected by the
 * send choke point in messageQueueHandler with a B01_METHOD_UNSUPPORTED
 * error, so the periodic poller can consult this instead of asking for
 * something the plugin already knows will fail.
 *
 * Derived from the same two sources the choke point uses, deliberately: a
 * separate hand-written list would drift the first time a translation is
 * added, and the drift would only show up as noise in a user's log.
 * @param {string} method
 * @returns {boolean}
 */
function canAnswerV1Method(method) {
  if (NEUTRAL_RESPONSES.has(method)) {
    return true;
  }

  try {
    return Boolean(translateOutgoing(method, []));
  } catch {
    return false;
  }
}

/**
 * Map a Q7 `prop.get` status payload to v1-shaped status fields.
 * Fixture reference: {"status":4,"quantity":87,"fault":0,...}
 * @param {any} data
 * @returns {{state: number, error_code: number, charge_status: number, dry_status: number, battery?: number, fan_power?: number}}
 */
/**
 * Translate a raw Q7 work-status code to the v1 state code, for HomeData
 * deviceStatus fallbacks where the cloud stores Q7-native values.
 * @param {unknown} rawStatus
 * @returns {number | null}
 */
function translateQ7WorkStatusToV1State(rawStatus) {
  const mapped = B01_STATUS_TO_V1_STATE[Number(rawStatus)];
  return mapped !== undefined ? mapped : null;
}

/**
 * @param {any} data
 * @returns {{state: number, error_code: number, charge_status: number, dry_status: number, battery?: number, fan_power?: number, matter_clean_type?: number}}
 */
function mapStatusToV1(data) {
  const source = data && typeof data === "object" ? data : {};
  const fault = Number(source.fault ?? 0) || 0;
  const rawStatus = Number(source.status);
  const mappedState = B01_STATUS_TO_V1_STATE[rawStatus];

  /** @type {{state: number, error_code: number, charge_status: number, dry_status: number, battery?: number, fan_power?: number, matter_clean_type?: number}} */
  const v1 = {
    // The Q7 fault field is a separate diagnostic channel: informational
    // codes (e.g. 407 "cleaning in progress / scheduled cleanup ignored")
    // linger after harmless events, so fault NEVER overrides the work
    // status. The reference implementation treats fault the same way.
    state: mappedState !== undefined ? mappedState : 3,
    error_code: INFORMATIONAL_B01_FAULTS.has(fault) ? 0 : fault,
    // Charging (4) and dock air-drying (10) count as on-charger so the
    // PowerSource cluster and the Charging/Docked tile logic see it.
    charge_status: rawStatus === 4 || rawStatus === 10 ? 1 : 0,
    // Status 10 is the dock air-drying the mop, and mapping it to v1 state 8
    // deliberately throws that away so the tile reads Docked rather than
    // inventing a state. The information is worth keeping though: drying is
    // the one dock job Matter has no operational state for, and the plugin
    // publishes it as a phase instead. `dry_status` is the field a v1 robot
    // with a drying dock uses for exactly this, so the B01 answer is written
    // under the same name rather than a private one.
    dry_status: rawStatus === 10 ? 1 : 0,
  };

  const battery = Number(source.quantity);
  if (Number.isFinite(battery)) {
    v1.battery = battery;
  }

  const fanPower = WIND_TO_V1_FAN_POWER[Number(source.wind)];
  if (fanPower !== undefined) {
    v1.fan_power = fanPower;
  }

  // The `mode` property carries the robot's current clean type (sweep /
  // sweep+mop / mop). Surface it as the Matter clean-mode id so the
  // accessory can mirror externally started cleans in Apple Home.
  const matterCleanType = Q7_CLEAN_TYPE_TO_MATTER[Number(source.mode)];
  if (matterCleanType !== undefined) {
    v1.matter_clean_type = matterCleanType;
  }

  return v1;
}

module.exports = {
  translateQ7WorkStatusToV1State,
  B01_MAP_UPLOAD_METHOD,
  createMapKey,
  decodeMapPayload,
  parseRoomsFromScMap,
  parseScMapLiveState,
  describeLiveRoomResolution,
  findCurrentMapId,
  MATTER_TO_Q7_CLEAN_TYPE,
  Q7_CLEAN_TYPE_TO_MATTER,
  B01_PROTOCOL_VERSION,
  B01_STATUS_PROPS,
  B01_STATUS_TO_V1_STATE,
  isB01Protocol,
  B01_CLOUD_ONLY_REMOTE_REASON,
  createB01MessageId,
  translateOutgoing,
  neutralResponse,
  canAnswerV1Method,
  mapStatusToV1,
};
