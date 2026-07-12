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
const B01_REQUEST_DPS = 10000;
const B01_RESPONSE_DPS = 10001;

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
    list.find(
      (/** @type {any} */ entry) => entry && entry.cur === true
    ) || list[0];
  return current && Number.isInteger(current.id) ? current.id : null;
}

const B01_MAP_UPLOAD_METHOD = "service.upload_by_mapid";

/** @param {unknown} version */
function isB01Protocol(version) {
  return version === B01_PROTOCOL_VERSION;
}

/** 12-digit decimal message id matching the observed Q7 wire format. */
function createB01MessageId() {
  return String(
    100000000000 + Math.floor(Math.random() * 899999999999)
  );
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
        params: { clean_type: CLEAN_TASK.ALL, ctrl_value: CTRL.START, room_ids: [] },
      };
    case "app_stop":
      return {
        method: "service.set_room_clean",
        params: { clean_type: CLEAN_TASK.ALL, ctrl_value: CTRL.STOP, room_ids: [] },
      };
    case "app_pause":
      return {
        method: "service.set_room_clean",
        params: { clean_type: CLEAN_TASK.ALL, ctrl_value: CTRL.PAUSE, room_ids: [] },
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
 * Map a Q7 `prop.get` status payload to v1-shaped status fields.
 * Fixture reference: {"status":4,"quantity":87,"fault":0,...}
 * @param {any} data
 * @returns {{state: number, error_code: number, charge_status: number, battery?: number, fan_power?: number}}
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
 * @returns {{state: number, error_code: number, charge_status: number, battery?: number, fan_power?: number}}
 */
function mapStatusToV1(data) {
  const source = data && typeof data === "object" ? data : {};
  const fault = Number(source.fault ?? 0) || 0;
  const rawStatus = Number(source.status);
  const mappedState = B01_STATUS_TO_V1_STATE[rawStatus];

  /** @type {{state: number, error_code: number, charge_status: number, battery?: number, fan_power?: number}} */
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
  };

  const battery = Number(source.quantity);
  if (Number.isFinite(battery)) {
    v1.battery = battery;
  }

  const fanPower = WIND_TO_V1_FAN_POWER[Number(source.wind)];
  if (fanPower !== undefined) {
    v1.fan_power = fanPower;
  }

  return v1;
}

module.exports = {
  translateQ7WorkStatusToV1State,
  B01_MAP_UPLOAD_METHOD,
  createMapKey,
  decodeMapPayload,
  parseRoomsFromScMap,
  findCurrentMapId,
  MATTER_TO_Q7_CLEAN_TYPE,
  B01_PROTOCOL_VERSION,
  B01_REQUEST_DPS,
  B01_RESPONSE_DPS,
  B01_STATUS_PROPS,
  B01_STATUS_TO_V1_STATE,
  isB01Protocol,
  createB01MessageId,
  translateOutgoing,
  neutralResponse,
  mapStatusToV1,
};
