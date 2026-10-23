"use strict";

const crypto = require("crypto");
const zlib = require("zlib");

/**
 * B01/Q7 protocol adapter.
 *
 * Roborock's 2025 Q7 series (`roborock.vacuum.sc01`, `sc05`) speaks the "B01"
 * protocol dialect: same 23-byte Roborock framing and AES-128-CBC payload
 * encryption, but a completely different RPC surface.
 *
 * IMPORTANT: `pv === "B01"` is NOT one protocol. The Q10 series (`ss*`, e.g.
 * `roborock.vacuum.ss07`) reports the same protocol version and the same
 * framing, but its RPC surface is different again — direct writes to numbered
 * datapoints, with no method name, no msgId and no dps 10000. This module is
 * the Q7 dialect only. `b01FamilyForModel` tells the two apart, and the send
 * choke point in messageQueueHandler refuses Q10 rather than publishing the Q7
 * form, which a Q10 discards without reply. See issue #19; this file listed
 * `ss07` as a Q7 model until 3.18.0, which is what made #14 take three rounds
 * to diagnose.
 *
 * Q7 requests carry a single JSON object on dps 10000:
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
// `current_map_id` (B01Props) tells the plugin when the robot switched maps,
// so the rooms, whose ids are per map, can follow at once.
const B01_STATUS_PROPS = [
  "status",
  "quantity",
  "fault",
  "wind",
  "mode",
  "current_map_id",
];

// Matter RVC clean modes (Vacuum=0, Mop=1, Vacuum+Mop=2) -> Q7 `mode`
// property values (CleanTypeMapping: VACUUM=0, VAC_AND_MOP=1, MOP=2).
// Note the crossed values: Matter's Mop is Q7's 2, Matter's combo is Q7's 1.
/** @type {Record<number, number>} */
const MATTER_TO_Q7_CLEAN_TYPE = { 0: 0, 1: 2, 2: 1 };
// Inverse direction: the Q7 reports its ACTIVE clean type in the same `mode`
// property on every status poll, so cleans started from the Roborock app (or
// the robot's buttons) can be reflected truthfully in Matter controllers. The
// mapping swaps 1 and 2 and keeps 0, so it is its own inverse: one table.
const Q7_CLEAN_TYPE_TO_MATTER = MATTER_TO_Q7_CLEAN_TYPE;

// service.set_room_clean control values (SCDeviceCleanParam).
const CTRL = { STOP: 0, START: 1, PAUSE: 2 };
// service.set_room_clean clean task types (CleanTaskTypeMapping).
const CLEAN_TASK = { ALL: 0, ROOM: 1 };

// B01 IS TWO PROTOCOL FAMILIES, NOT ONE, AND THEIR SUCTION SCALES DISAGREE.
//
// `pv === "B01"` covers the Q7 series (`sc01`, `sc05`) and the Q10 series
// (`ss07`). They are not the same wire protocol. Until 3.15.5 everything B01
// went through the Q7 tables, which on a Q10 meant:
//
//   * Max+ sent `wind: 5`, a value that does not exist in the Q10 scale;
//   * the robot's own Max+, `wind: 8`, resolved to undefined and never
//     reported back;
//   * `wind: 0` (off) had nowhere to go, because the Q7 has no such level.
//
// Read from python-roborock's own enums rather than guessed:
// `SCWindMapping` (Q7) is 1-4 with Max+ at 5, `YXFanLevel` (Q10) is 0-4 with
// Max+ at 8 and a genuine off at 0. The 2 families also disagree about what
// their shared fault numbers mean, which is why the informational sets below
// are separate too — upstream documents the collision explicitly for 500,
// 501, 503, 569 and 570.
//
// The suction and fault tables below were split ahead of the first field Q10.
// That much was right — but it treated the split as a matter of enum values,
// when the two families do not even share a request envelope. The first Q10 in
// the field (#14, `ss07`, 26 Aug 2026) could not run a single command, because
// the family flag reached these tables and nothing else. Getting the enums
// right for a dialect that is never spoken correctly buys nothing: the split
// has to reach the wire format too, which is #19.
//
// Clean type is the other table that is still Q7-only: Q7 is vacuum=0,
// vac+mop=1, mop=2, while Q10 (`YXCleanType`) is vac+mop=1, vacuum=2, mop=3.
// MATTER_TO_Q7_CLEAN_TYPE below must not be reused for Q10.
const B01_FAMILY = { Q7: "Q7", Q10: "Q10" };

/**
 * Which B01 family a model belongs to.
 *
 * Anchored on the model suffix. Upstream uses an unanchored substring test
 * (`if "ss" in model_part`) which would misroute any future model that merely
 * contains those letters; this does not copy that.
 *
 * Anything else, a missing model included, is neither family: null. It used
 * to default to Q7, so a Q10 whose product lookup missed was sent Q7 frames it
 * discards, every status tick (#19). python-roborock refuses such a device
 * (`device_manager.device_creator`: UnsupportedDeviceError).
 *
 * @param {string | null | undefined} model
 * @returns {string | null}
 */
function b01FamilyForModel(model) {
  const suffix = String(model ?? "")
    .split(".")
    .pop()
    ?.toLowerCase();
  if (suffix && suffix.startsWith("ss")) {
    return B01_FAMILY.Q10;
  }
  if (suffix && suffix.startsWith("sc")) {
    return B01_FAMILY.Q7;
  }
  return null;
}

// Q7 `wind` (suction) codes <-> v1 fan_power codes.
/** @type {Record<number, number>} */
const Q7_WIND_TO_V1_FAN_POWER = { 1: 101, 2: 102, 3: 103, 4: 104, 5: 108 };
/** @type {Record<number, number>} */
const Q7_V1_FAN_POWER_TO_WIND = {
  101: 1, // quiet
  102: 2, // balanced
  103: 3, // turbo
  104: 4, // max
  108: 5, // max+
  105: 1, // "off" has no Q7 equivalent; degrade to quiet
  106: 2, // custom -> balanced
};

// Q10 `wind` codes <-> v1 fan_power codes (upstream `YXFanLevel`).
/** @type {Record<number, number>} */
const Q10_WIND_TO_V1_FAN_POWER = {
  0: 105, // off — the Q10 has one and the Q7 does not
  1: 101,
  2: 102,
  3: 103,
  4: 104,
  8: 108, // max+
};
/** @type {Record<number, number>} */
const Q10_V1_FAN_POWER_TO_WIND = {
  101: 1,
  102: 2,
  103: 3,
  104: 4,
  108: 8, // max+ — 5 on this family is not a level at all
  105: 0, // off is real here, so it is not degraded to quiet
  106: 2, // custom -> balanced
};

/** @param {string | null} family */
function windToV1FanPower(family) {
  return family === B01_FAMILY.Q10
    ? Q10_WIND_TO_V1_FAN_POWER
    : Q7_WIND_TO_V1_FAN_POWER;
}

/** @param {string | null} family */
function v1FanPowerToWind(family) {
  return family === B01_FAMILY.Q10
    ? Q10_V1_FAN_POWER_TO_WIND
    : Q7_V1_FAN_POWER_TO_WIND;
}

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
// Fault codes that are informational rather than active errors — per family,
// because the 2 families reuse the same numbers for different things.
//
// Q7: 407 = "Cleaning in progress. Scheduled cleanup ignored", 2100 = "Low
// battery. Resume cleaning after recharging", 2102 = "Cleaning completed.
// Returning to the dock".
// Q10: 400 = scheduled clean starting, 407 = cleaning in progress and a due
// scheduled clean ignored, 501 = cleaning completed and returning
// (hardware-confirmed upstream, and it fires after EVERY task, so treating it
// as a fault would leave a Q10 permanently in error), 502 = low-battery
// resume.
//
// EACH FAMILY NEEDS ITS OWN PER-TASK COMPLETION CODE, AND THE Q7 WAS MISSING
// ITS ONE UNTIL 3.23.1. The 2 sets started from the codes each family had
// actually been measured emitting, which left them asymmetric in both
// directions: the Q10 had its after-every-task code (501) while the Q7 did
// not, and the Q7 had 407 while the Q10 did not — even though upstream marks
// `YXFault` 407 hardware-confirmed on a physical ss07 and "lifecycle, not an
// error".
//
// The Q7 gap surfaced on the maintainer's own `sc05`, which logged 6 distinct
// unmapped codes in a single day (2110, 2108, 501, 2102, 2103, 2105), every
// one of them mid-run, and then finished and docked at 100 % with nothing
// wrong. Read against python-roborock's `B01Fault`, 2 of the 6 are not faults:
// 2102 fires after every task, and 2100 is the robot announcing normal
// auto-recharge-and-resume — the Q7 analogue of the Q10's 502.
//
// WHAT IS DELIBERATELY LEFT SURFACING, BECAUSE SILENCE IS NOT FREE. Only a
// healthy robot's lifecycle notifications belong here. Q7's 2003 ("Battery
// level below 20%. Scheduled task canceled") and 2007/2012 ("Unable to reach
// the target. Cleaning ended") are outcomes a user may want to know about — a
// scheduled clean that did not run is not noise. And the codes upstream has no
// description for at all (2105, 2108, 2110 are bare `fault_NNNN` there) stay
// put: silencing a number nobody has explained would be a guess, not a
// translation. 2103 is not one of them: upstream's `B01Fault.F_2103` is "task
// finished and robot docked ... persists while docked-idle. Not an error
// (hw-confirmed on a Q7 M5+)", and the maintainer's sc05 logs it after every
// run.
const INFORMATIONAL_Q7_FAULTS = new Set([0, 407, 2100, 2102, 2103]);
const INFORMATIONAL_Q10_FAULTS = new Set([0, 400, 407, 501, 502]);

// Matter RvcOperationalState error ids (ErrorStateEnum), for the B01 fault
// tables below. The Matter accessory publishes these through the same path a
// classic robot's faults take.
const MATTER_RVC_ERROR = Object.freeze({
  UNABLE_TO_COMPLETE_OPERATION: 2,
  FAILED_TO_FIND_CHARGING_DOCK: 64,
  STUCK: 65,
  DUST_BIN_MISSING: 66,
  DUST_BIN_FULL: 67,
  MOP_CLEANING_PAD_MISSING: 71,
});

// Q7 faults that are a condition the user has to fix, and the Matter error
// each one is. Labels are python-roborock's `B01Fault` names; the Matter ids
// follow the classic table in matter_vacuum_accessory.ts, so a jammed brush or
// a trapped robot reads the same on a Q7 as on an S8 (wheels and bumper:
// Stuck; brushes and sensors: UnableToCompleteOperation, with the Matter 1.4
// code the classic table also names but does not send).
//
// LEFT OUT ON PURPOSE:
//   * 500, 501, 503, 569 and 570. Upstream documents that these numbers mean
//     different things on the two B01 families, and the maintainer's sc05 sent
//     501 ("robot_suspended" in the Q7 table) at the end of a normal run, just
//     before docking (pi-roborock.log, 21 Oct 2026) — which is the Q10's
//     meaning, "cleaning completed, returning". A label that is wrong for this
//     range on real hardware cannot be trusted to publish a fault.
//   * Outcomes rather than conditions: 2003, 2007/2012 (cannot reach the
//     target, cleaning ended), 611/612 (positioning failed, try again). The Q7
//     fault field lingers after events (2103 persists while docked), and a
//     Matter fault forces the Error state, which refuses a Start — so a
//     finished run's outcome must not stand as a blocking error.
//   * Low-battery codes (502, 518, 533, 534): the robot handles those itself.
// Anything not listed is logged once by the accessory and never published.
/** @type {ReadonlyMap<number, {id: number, roborock: string, spec?: string}>} */
const Q7_FAULT_TO_MATTER = new Map([
  [
    509,
    {
      id: MATTER_RVC_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "cliff_sensor_error",
      spec: "NavigationSensorObscured (78)",
    },
  ],
  [510, { id: MATTER_RVC_ERROR.STUCK, roborock: "bumper_stuck" }],
  [
    511,
    {
      id: MATTER_RVC_ERROR.FAILED_TO_FIND_CHARGING_DOCK,
      roborock: "docking_error",
    },
  ],
  [
    512,
    {
      id: MATTER_RVC_ERROR.FAILED_TO_FIND_CHARGING_DOCK,
      roborock: "docking_error",
    },
  ],
  [513, { id: MATTER_RVC_ERROR.STUCK, roborock: "robot_trapped" }],
  [514, { id: MATTER_RVC_ERROR.STUCK, roborock: "robot_trapped" }],
  [
    522,
    {
      id: MATTER_RVC_ERROR.MOP_CLEANING_PAD_MISSING,
      roborock: "mop_not_installed",
    },
  ],
  [
    560,
    {
      id: MATTER_RVC_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "side_brush_entangled",
      spec: "BrushJammed (77)",
    },
  ],
  [
    568,
    {
      id: MATTER_RVC_ERROR.STUCK,
      roborock: "main_wheels_entangled",
      spec: "WheelsJammed (76)",
    },
  ],
  [
    572,
    {
      id: MATTER_RVC_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "main_brush_entangled",
      spec: "BrushJammed (77)",
    },
  ],
  [
    594,
    {
      id: MATTER_RVC_ERROR.DUST_BIN_MISSING,
      roborock: "dust_bag_not_installed",
    },
  ],
  [
    629,
    {
      id: MATTER_RVC_ERROR.MOP_CLEANING_PAD_MISSING,
      roborock: "mop_mount_fell_off",
    },
  ],
  [
    668,
    {
      id: MATTER_RVC_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "system_error",
    },
  ],
]);

/**
 * The Matter fault a Q7 `fault` code stands for, or null when it is not a
 * condition this table can name (see Q7_FAULT_TO_MATTER).
 * @param {number} code
 * @returns {{id: number, roborock: string, spec?: string} | null}
 */
function describeQ7Fault(code) {
  return Q7_FAULT_TO_MATTER.get(Number(code)) ?? null;
}

/** @param {string} family */
function informationalFaults(family) {
  return family === B01_FAMILY.Q10
    ? INFORMATIONAL_Q10_FAULTS
    : INFORMATIONAL_Q7_FAULTS;
}

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
  // working_sleep: "an untouched pause falls asleep after ~10 minutes; the
  // job is kept" (Home Assistant maps it to PAUSED). Read as Idle, a paused
  // run looked finished.
  11: 10,
};

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
 * Shared minimal protobuf wire reader for the SCMap RobotMap payload.
 * Reference schema: python-roborock map/proto/b01_scmap.proto.
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

/**
 * Walk one protobuf message and hand every field to `visit` with its number,
 * wire type and value: a number for varint (0), double (1) and float (5), the
 * bytes for a length-delimited field (2). Fields nobody reads cost nothing but
 * the walk, so every message reader below is just a `visit`.
 *
 * @param {Buffer} buf
 * @param {(field: number, wireType: number, value: any) => void} visit
 */
function forEachField(buf, visit) {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    let value;
    let end;
    if (wireType === 0) {
      const varint = readVarint(buf, pos);
      value = varint.value;
      end = varint.pos;
    } else if (wireType === 2) {
      const length = readVarint(buf, pos);
      end = length.pos + length.value;
      value = buf.subarray(length.pos, end);
    } else if (wireType === 1 || wireType === 5) {
      end = pos + (wireType === 1 ? 8 : 4);
      if (end > buf.length) {
        throw new Error("Truncated fixed-width field in SCMap payload");
      }
      value = wireType === 1 ? buf.readDoubleLE(pos) : buf.readFloatLE(pos);
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
    visit(field, wireType, value);
    pos = end;
  }
}

/**
 * RoomDataInfo: roomId (1, varint) and roomName (2, string).
 * @param {Buffer} buf
 */
function parseRoom(buf) {
  /** @type {{roomId: number, roomName: string}} */
  const room = { roomId: -1, roomName: "" };
  forEachField(buf, (field, wireType, value) => {
    if (field === 1 && wireType === 0) room.roomId = value;
    else if (field === 2 && wireType === 2)
      room.roomName = value.toString("utf8");
  });
  return room;
}

/**
 * The rooms (RobotMap field 12, RoomDataInfo) of an SCMap payload.
 * @param {Buffer} buffer
 * @returns {Array<{roomId: number, roomName: string}>}
 */
function parseRoomsFromScMap(buffer) {
  return parseScMapLiveState(buffer).rooms;
}

/**
 * Parse the SCMap RobotMap fields needed to derive the robot's live room:
 * map head (field 3: grid geometry), current pose (field 8: world-coordinate
 * robot position in meters) and room outline chains (field 14: per-room
 * boundary contours in grid-cell coordinates), plus the room names (field
 * 12). Every other field is skipped.
 *
 * Wire reference (python-roborock b01_scmap.proto):
 * - RobotMap:               mapType=1 varint (0 = the live map of a run)
 * - MapHeadInfo:            sizeX=2 varint, sizeY=3 varint, minX=4 float,
 *                           minY=5 float, maxX=6 float, maxY=7 float,
 *                           resolution=8 float
 * - DeviceCurrentPoseInfo:  poseId=1 varint, update=2 varint,
 *                           x=3 float, y=4 float, phi=5 float
 * - RoomOutlineInfo:        roomId=1 varint,
 *                           points=2 repeated {x=1 varint, y=2 varint}
 * @param {Buffer} buffer
 * @returns {{
 *   mapType: number,
 *   head: {sizeX: number, sizeY: number, minX: number, minY: number, maxX: number, maxY: number, resolution: number} | null,
 *   pose: {x: number, y: number, update?: number} | null,
 *   rooms: Array<{roomId: number, roomName: string}>,
 *   roomChains: Array<{roomId: number, points: Array<{x: number, y: number}>}>,
 * }}
 */
function parseScMapLiveState(buffer) {
  // RobotMap.mapType (field 1). proto2 reads an absent field as 0, and so
  // does python-roborock's parse_map_type, so an untyped frame is live.
  let mapType = 0;
  /** @type {{sizeX: number, sizeY: number, minX: number, minY: number, maxX: number, maxY: number, resolution: number} | null} */
  let head = null;
  /** @type {{x: number, y: number, update?: number} | null} */
  let pose = null;
  /** @type {Array<{roomId: number, points: Array<{x: number, y: number}>}>} */
  const roomChains = [];
  /** @type {Array<{roomId: number, roomName: string}>} */
  const rooms = [];

  /** @param {Buffer} buf */
  function parseMapHead(buf) {
    const parsed = {
      sizeX: 0,
      sizeY: 0,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      resolution: 0.05,
    };
    forEachField(buf, (field, wireType, value) => {
      if (wireType === 0) {
        if (field === 2) parsed.sizeX = value;
        else if (field === 3) parsed.sizeY = value;
      } else if (wireType === 5) {
        if (field === 4) parsed.minX = value;
        else if (field === 5) parsed.minY = value;
        else if (field === 6) parsed.maxX = value;
        else if (field === 7) parsed.maxY = value;
        else if (field === 8 && value > 0) parsed.resolution = value;
      }
    });
    return parsed;
  }

  /** @param {Buffer} buf */
  function parseCurrentPose(buf) {
    /** @type {{x: number | null, y: number | null, update?: number}} */
    const parsed = { x: null, y: null };
    forEachField(buf, (field, wireType, value) => {
      if (field === 2 && wireType === 0) parsed.update = value;
      if (wireType !== 5) return;
      if (field === 3) parsed.x = value;
      else if (field === 4) parsed.y = value;
    });
    if (parsed.x === null || parsed.y === null) {
      return null;
    }
    return parsed.update === undefined
      ? { x: parsed.x, y: parsed.y }
      : { x: parsed.x, y: parsed.y, update: parsed.update };
  }

  /** @param {Buffer} buf */
  function parseChainPoint(buf) {
    const point = { x: 0, y: 0 };
    forEachField(buf, (field, wireType, value) => {
      if (wireType !== 0) return;
      if (field === 1) point.x = value;
      else if (field === 2) point.y = value;
    });
    return point;
  }

  /** @param {Buffer} buf */
  function parseRoomChain(buf) {
    /** @type {{roomId: number, points: Array<{x: number, y: number}>}} */
    const chain = { roomId: -1, points: [] };
    forEachField(buf, (field, wireType, value) => {
      if (field === 1 && wireType === 0) chain.roomId = value;
      else if (field === 2 && wireType === 2)
        chain.points.push(parseChainPoint(value));
    });
    return chain;
  }

  forEachField(buffer, (field, wireType, value) => {
    if (field === 1 && wireType === 0) {
      mapType = value;
    }
    if (wireType !== 2) {
      return;
    }
    if (field === 3) {
      head = parseMapHead(value);
    } else if (field === 8) {
      pose = parseCurrentPose(value);
    } else if (field === 12) {
      const room = parseRoom(value);
      if (room.roomId >= 0) {
        rooms.push(room);
      }
    } else if (field === 14) {
      const chain = parseRoomChain(value);
      if (chain.roomId >= 0 && chain.points.length >= 3) {
        roomChains.push(chain);
      }
    }
  });

  return {
    mapType,
    head,
    pose,
    rooms,
    roomChains,
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

  // A pose outside the map is no position at all, whatever the outlines say:
  // python-roborock's _WorldToPixel.in_bounds "rejects placeholder poses", and
  // the saved map's (1100, 1100) is exactly such a pose.
  if (!isPoseInMapBounds(pose, head)) {
    return {
      roomId: null,
      reason: "pose-placeholder",
      outlineCount,
      cell,
      outlineBounds: outlineBoundingBox(chains),
      head: { minX: head.minX, minY: head.minY, resolution },
    };
  }

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
 * Whether a world-coordinate pose lies inside the map, as python-roborock's
 * `_WorldToPixel.in_bounds` decides it: minX..maxX by minY..maxY. A header
 * without maxX/maxY is bounded by its raster size instead; one with neither
 * cannot rule a pose out.
 *
 * @param {{x: number, y: number}} pose
 * @param {{minX: number, minY: number, resolution: number, maxX?: number,
 *          maxY?: number, sizeX?: number, sizeY?: number}} head
 * @returns {boolean}
 */
function isPoseInMapBounds(pose, head) {
  const resolution = head.resolution > 0 ? head.resolution : 0.05;
  const maxX =
    Number(head.maxX) > head.minX
      ? Number(head.maxX)
      : Number(head.sizeX) > 0
        ? head.minX + Number(head.sizeX) * resolution
        : null;
  const maxY =
    Number(head.maxY) > head.minY
      ? Number(head.maxY)
      : Number(head.sizeY) > 0
        ? head.minY + Number(head.sizeY) * resolution
        : null;
  if (maxX === null || maxY === null) {
    return true;
  }
  return (
    head.minX <= pose.x &&
    pose.x <= maxX &&
    head.minY <= pose.y &&
    pose.y <= maxY
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

// RobotMap.mapType of the live map a Q7 pushes while it cleans. "Type 0 is the
// live map of the current cleaning run, other types are historic or saved
// maps" (python-roborock b01_map_parser.parse_map_type).
const B01_LIVE_MAP_TYPE = 0;

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
 * @param {string | null} [family] Q7 when not given
 * @returns {{method: string, params: any, kind?: string} | null}
 */
function translateOutgoing(method, params, family = B01_FAMILY.Q7) {
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
      const wind = v1FanPowerToWind(family)[v1Code];
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
  // Q7/B01 has no v1 server-timer implementation. The neutral empty
  // response keeps the shared polling path structurally valid; it means
  // this model exposes no HAP schedule snapshot rather than a transport error.
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
  return (
    NEUTRAL_RESPONSES.has(method) || Boolean(translateOutgoing(method, []))
  );
}

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
 * Map a Q7 `prop.get` status payload to v1-shaped status fields.
 * Fixture reference: {"status":4,"quantity":87,"fault":0,...}
 * @param {any} data
 * @param {string} [family] one of B01_FAMILY; Q7 when not given
 * @returns {{state?: number, error_code: number, charge_status?: number, dry_status?: number, battery?: number, fan_power?: number, matter_clean_type?: number}}
 */
function mapStatusToV1(data, family = B01_FAMILY.Q7) {
  const source = data && typeof data === "object" ? data : {};
  const fault = Number(source.fault ?? 0) || 0;
  const rawStatus = Number(source.status);
  const mappedState = B01_STATUS_TO_V1_STATE[rawStatus];

  /** @type {{state?: number, error_code: number, charge_status?: number, dry_status?: number, battery?: number, fan_power?: number, matter_clean_type?: number}} */
  const v1 = {
    // The Q7 fault field is a separate diagnostic channel: informational
    // codes (e.g. 407 "cleaning in progress / scheduled cleanup ignored")
    // linger after harmless events, so fault NEVER overrides the work
    // status. The reference implementation treats fault the same way.
    error_code: informationalFaults(family).has(fault) ? 0 : fault,
  };

  // A work status this table does not know, or none at all, says nothing
  // about the robot. Defaulting it to Idle-off-the-dock published a docked or
  // paused robot as idle whenever an answer came back partial; leaving the
  // fields out keeps whatever was last known (upstream maps unknown codes to
  // UNKNOWN, never to a real state).
  if (mappedState !== undefined) {
    v1.state = mappedState;
    // Charging (4) and dock air-drying (10) count as on-charger so the
    // PowerSource cluster and the Charging/Docked tile logic see it.
    v1.charge_status = rawStatus === 4 || rawStatus === 10 ? 1 : 0;
    // Status 10 is the dock air-drying the mop, and mapping it to v1 state 8
    // deliberately throws that away so the tile reads Docked rather than
    // inventing a state. The information is worth keeping though: drying is
    // the one dock job Matter has no operational state for, and the plugin
    // publishes it as a phase instead. `dry_status` is the field a v1 robot
    // with a drying dock uses for exactly this, so the B01 answer is written
    // under the same name rather than a private one.
    v1.dry_status = rawStatus === 10 ? 1 : 0;
  }

  const battery = Number(source.quantity);
  if (Number.isFinite(battery)) {
    v1.battery = battery;
  }

  const fanPower = windToV1FanPower(family)[Number(source.wind)];
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
  B01_LIVE_MAP_TYPE,
  MATTER_RVC_ERROR,
  describeQ7Fault,
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
  B01_FAMILY,
  b01FamilyForModel,
  // Exported for b01Q10Adapter, so the Q10 suction and fault tables have one
  // home rather than a second copy that can drift from this one.
  v1FanPowerToWind,
  windToV1FanPower,
  informationalFaults,
  normalizeSegmentIds,
};
