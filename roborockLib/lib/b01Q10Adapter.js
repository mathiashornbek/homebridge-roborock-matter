// @ts-check
"use strict";

/**
 * The B01 Q10 dialect (`roborock.vacuum.ss*`).
 *
 * `pv === "B01"` is TWO wire protocols, not one. `b01Q7Adapter` implements the
 * Q7 dialect (`sc*`), which carries an RPC envelope on datapoint 10000:
 *
 *   {"dps":{"10000":{"method":"prop.set","msgId":"…","params":…}}}
 *
 * The Q10 dialect writes a numbered datapoint directly, with no method, no
 * msgId and no datapoint 10000 at all:
 *
 *   {"dps":{"201":1}}
 *
 * The consequence that matters for this file: **a Q10 command is
 * fire-and-forget.** The dialect defines no RPC reply, so there is nothing to
 * correlate a msgId against even when the command works perfectly. Upstream's
 * own channel says so in its type signature — `send_command(...) -> None`.
 *
 * That is why this adapter translates COMMANDS ONLY, and deliberately refuses
 * to translate reads such as `get_status`, `get_map_list` and `get_prop`. A
 * read whose value is the answer cannot be served by a dialect that never
 * answers; translating one would resolve the caller with a fabricated
 * acknowledgement and then feed that non-answer to `mapStatusToV1`, publishing
 * nonsense to Apple Home. Status on a Q10 continues to come from home data
 * over HTTPS, which is a different transport and is measured to work (#14,
 * 26 Aug 2026). Reading state off the datapoint updates the robot pushes is
 * the other half of #19 and needs the incoming path, not this file.
 *
 * Every code below is read from python-roborock rather than guessed:
 * `roborock/data/b01_q10/b01_q10_code_mappings.py` for the datapoint numbers
 * and enums, `roborock/devices/traits/b01/q10/vacuum.py` for the payload of
 * each command, where the docstrings mark them "Verified live against ss07
 * hardware". None of it is verified by this project — there is no Q10 here.
 * See #19.
 */

const b01Q7Adapter = require("./b01Q7Adapter");

/**
 * Q10 datapoint codes (`B01_Q10_DP`). Only the ones this file uses are
 * listed; the upstream enum is far longer.
 */
const B01_Q10_DP = {
  FAULT: 90,
  COMMON: 101,
  REQUEST_DPS: 102,
  STATUS: 121,
  BATTERY: 122,
  FAN_LEVEL: 123,
  CLEAN_MODE: 137,
  START_CLEAN: 201,
  START_BACK: 202,
  START_DOCK_TASK: 203,
  PAUSE: 204,
  RESUME: 205,
  STOP: 206,
};

/**
 * `YXDeviceCleanTask` — the task selector carried by dpStartClean (201).
 * Spot (`PART`, 5) is in the dialect but is not listed here: the plugin never
 * issues `app_spot`, and a mapping no caller can reach is untested surface.
 */
const YX_CLEAN_TASK = {
  SMART: 1, // whole home
  ELECTORAL: 2, // segment / room
};

/**
 * dpStartBack (202) task codes. 5 = charge, which is what the official app
 * sends for "return to dock"; 1 washes the mop en route and 4 collects dust
 * en route, and neither is what a Matter "go home" means.
 */
const Q10_BACK_TO_DOCK_CHARGE = 5;

/** dpStartDockTask (203): 2 = collect dust. */
const Q10_DOCK_TASK_COLLECT_DUST = 2;

/**
 * Matter clean-type codes -> `YXCleanType`.
 *
 * THIS IS NOT THE Q7 TABLE AND MUST NEVER BE SUBSTITUTED FOR IT. Q7 is
 * vacuum=0, vac+mop=1, mop=2. Q10 is vac_and_mop=1, vacuum=2, mop=3. The
 * numbers overlap, so a wrong table does not fail loudly — it mops when it was
 * asked to vacuum.
 * @type {Record<number, number>}
 */
const MATTER_TO_Q10_CLEAN_TYPE = { 0: 2, 1: 3, 2: 1 };

/**
 * Inverse of the above, for reading a Q10's reported clean type back into
 * Matter terms.
 * @type {Record<number, number>}
 */
const Q10_CLEAN_TYPE_TO_MATTER = { 1: 2, 2: 0, 3: 1 };

/**
 * Translate a v1-shaped outgoing command to a Q10 datapoint write.
 *
 * Returns `{dp, params}` for a command the dialect can express, or `null` for
 * anything else — including every read. `null` means the caller must refuse
 * rather than invent a payload; a guessed datapoint on a robot nobody here
 * owns is exactly the class of mistake #14 cost three rounds.
 *
 * @param {string} method
 * @param {any} params
 * @returns {{dp: number, params: any} | null}
 */
function translateOutgoing(method, params) {
  switch (method) {
    case "app_start":
      return { dp: B01_Q10_DP.START_CLEAN, params: YX_CLEAN_TASK.SMART };
    case "app_stop":
      return { dp: B01_Q10_DP.STOP, params: 0 };
    case "app_pause":
      return { dp: B01_Q10_DP.PAUSE, params: 0 };
    case "app_charge":
      return { dp: B01_Q10_DP.START_BACK, params: Q10_BACK_TO_DOCK_CHARGE };
    case "app_start_collect_dust":
      return {
        dp: B01_Q10_DP.START_DOCK_TASK,
        params: Q10_DOCK_TASK_COLLECT_DUST,
      };
    case "app_segment_clean":
    case "app_segment_clean_by_ids": {
      const roomIds = b01Q7Adapter.normalizeSegmentIds(params);
      if (!roomIds.length) {
        return null;
      }
      return {
        dp: B01_Q10_DP.START_CLEAN,
        params: {
          cmd: YX_CLEAN_TASK.ELECTORAL,
          // "clean_paramters" mirrors the firmware's own misspelling of
          // "parameters". Upstream documents that the device accepts that key
          // and only that key. Do not correct it.
          clean_paramters: roomIds,
        },
      };
    }
    case "set_custom_mode": {
      const v1Code = Array.isArray(params) ? params[0] : params;
      // One suction table, shared with the Q7 adapter's family switch, rather
      // than a second copy here that could drift from it.
      const wind = b01Q7Adapter.v1FanPowerToWind(b01Q7Adapter.B01_FAMILY.Q10)[
        v1Code
      ];
      return wind === undefined
        ? null
        : { dp: B01_Q10_DP.FAN_LEVEL, params: wind };
    }
    case "set_clean_type": {
      const matterMode = Array.isArray(params) ? params[0] : params;
      const q10Mode = MATTER_TO_Q10_CLEAN_TYPE[matterMode];
      return q10Mode === undefined
        ? null
        : { dp: B01_Q10_DP.CLEAN_MODE, params: q10Mode };
    }
    default:
      // Everything else, reads included, is refused by the caller.
      return null;
  }
}

/**
 * The wire payload body for a datapoint write: `{"dps":{"<dp>": params}}`.
 *
 * `params` of `0` is a real value on this dialect — pause, resume and stop all
 * send it — so only `null`/`undefined` degrade to the empty object, exactly as
 * upstream's `encode_mqtt_payload` does.
 *
 * @param {number} dp
 * @param {any} params
 * @returns {Record<string, any>}
 */
function buildDps(dp, params) {
  return {
    [String(dp)]: params !== undefined && params !== null ? params : {},
  };
}

/**
 * Q10 work status (datapoint 121, python-roborock `YXDeviceState`) -> the v1
 * state code with the same meaning.
 *
 * The Q10 numbers its common states exactly as v1 does (2 sleeping, 3 idle,
 * 5 cleaning, 6 returning, 8 charging, 10 paused, 12 error, 14 updating,
 * 22 emptying the bin, 29 mapping), so those pass through. What it adds are
 * the sub-states of a run (99 saving the map, 101 relocating, 102 sweeping,
 * 103 mopping, 104 sweeping and mopping, 105 transitioning) and 108 waiting
 * to charge. Read as v1 numbers those land on v1's 101 "device offline" and
 * 103 "locked", so they are folded into the run (5) and charging (8).
 *
 * Until 3.35.0 the home-data snapshot of EVERY `pv === "B01"` robot went
 * through the Q7 table instead, which is a different numbering: a charging
 * Q10 (8) became Stopped, an idle one (3) became Docking. A push of the same
 * datapoint was read as v1, so the two sources disagreed and the tile flapped
 * between them (#33).
 *
 * @type {Record<number, number>}
 */
const Q10_STATUS_TO_V1_STATE = {
  2: 2,
  3: 3,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  10: 10,
  12: 12,
  14: 14,
  22: 22,
  29: 29,
  99: 5,
  101: 5,
  102: 5,
  103: 5,
  104: 5,
  105: 5,
  108: 8,
};

const RVC = b01Q7Adapter.MATTER_RVC_ERROR;

/**
 * Q10 `dpFault` (90) codes that are a condition the user has to fix, and the
 * Matter error each one is. Labels are python-roborock's `YXFault` names; the
 * Matter ids follow the classic table, as the Q7 table does.
 *
 * Left out: the lifecycle codes (INFORMATIONAL_Q10_FAULTS), outcomes that a
 * lingering field would turn into a standing Error (556 positioning failed,
 * 570 cannot reach target), the battery codes the robot handles itself, and
 * service-life reminders (301-304). 310 is inferred upstream from auto-empty
 * context rather than hardware-confirmed; a full bag is a condition either way.
 *
 * @type {ReadonlyMap<number, {id: number, roborock: string, spec?: string}>}
 */
const Q10_FAULT_TO_MATTER = new Map([
  [
    1,
    {
      id: RVC.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "lidar_blocked",
      spec: "NavigationSensorObscured (78)",
    },
  ],
  [2, { id: RVC.STUCK, roborock: "bumper_stuck" }],
  [
    3,
    {
      id: RVC.STUCK,
      roborock: "robot_suspended",
      spec: "WheelsJammed (76)",
    },
  ],
  [
    4,
    {
      id: RVC.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "cliff_sensor_error",
      spec: "NavigationSensorObscured (78)",
    },
  ],
  [
    5,
    {
      id: RVC.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "main_brush_stuck",
      spec: "BrushJammed (77)",
    },
  ],
  [
    7,
    {
      id: RVC.STUCK,
      roborock: "main_wheels_stuck",
      spec: "WheelsJammed (76)",
    },
  ],
  [8, { id: RVC.STUCK, roborock: "robot_trapped" }],
  [9, { id: RVC.DUST_BIN_MISSING, roborock: "check_dustbin_filter" }],
  [46, { id: RVC.DUST_BIN_MISSING, roborock: "install_dust_bag" }],
  [54, { id: RVC.MOP_CLEANING_PAD_MISSING, roborock: "mop_mount_fell_off" }],
  [310, { id: RVC.DUST_BIN_FULL, roborock: "dust_bag_full" }],
  [503, { id: RVC.FAILED_TO_FIND_CHARGING_DOCK, roborock: "docking_error" }],
]);

/**
 * The Matter fault a Q10 `dpFault` code stands for, or null.
 * @param {number} code
 * @returns {{id: number, roborock: string, spec?: string} | null}
 */
function describeQ10Fault(code) {
  return Q10_FAULT_TO_MATTER.get(Number(code)) ?? null;
}

/**
 * @param {unknown} rawStatus a Q10 datapoint-121 value
 * @returns {number | null} the v1 state, or null when the code is not known
 */
function translateQ10StatusToV1State(rawStatus) {
  if (rawStatus === null || rawStatus === undefined || rawStatus === "") {
    return null;
  }
  const mapped = Q10_STATUS_TO_V1_STATE[Number(rawStatus)];
  return mapped !== undefined ? mapped : null;
}

/**
 * Datapoints a Q10 pushed, read as the v1-shaped status fields the rest of the
 * plugin speaks.
 *
 * This is the one place a Q10 push is interpreted. The accessory reads v1
 * datapoints, so a raw Q10 frame read there landed its suction (123) in the
 * wrong units and its clean mode (137) and fault (90) nowhere. python-roborock
 * flattens the nested dpCommon (101) into the top level before reading
 * anything (b01_q10_protocol.decode_rpc_response), so a fault pushed under 101
 * is the same fault as one pushed at the top level.
 *
 * Only what can be read faithfully is returned: an unknown state, suction or
 * clean mode is left out, never guessed, and the water level (124) is not
 * mapped because this plugin has no Q10 water control to mirror it into.
 *
 * @param {Record<string, unknown>} dps
 * @returns {{state?: number, charge_status?: number, battery?: number,
 *            fan_power?: number, matter_clean_type?: number,
 *            error_code?: number, in_cleaning?: number}}
 */
function mapDpsToV1(dps) {
  /** @type {Record<string, unknown>} */
  const flat = { ...dps };
  const common = flat[String(B01_Q10_DP.COMMON)];
  delete flat[String(B01_Q10_DP.COMMON)];
  if (common && typeof common === "object" && !Array.isArray(common)) {
    Object.assign(flat, common);
  }
  /** @param {number} dp */
  const has = (dp) => Object.prototype.hasOwnProperty.call(flat, String(dp));

  /** @type {ReturnType<typeof mapDpsToV1>} */
  const v1 = {};
  if (has(B01_Q10_DP.STATUS)) {
    const state = translateQ10StatusToV1State(flat[String(B01_Q10_DP.STATUS)]);
    if (state !== null) {
      v1.state = state;
      // Emptying the bin happens on the dock; whether it charges meanwhile is
      // not said, so the last known value stands.
      if (state !== 22) {
        v1.charge_status = state === 8 ? 1 : 0;
      }
    }
  }
  if (has(B01_Q10_DP.BATTERY)) {
    const battery = Number(flat[String(B01_Q10_DP.BATTERY)]);
    if (Number.isFinite(battery)) {
      v1.battery = battery;
    }
  }
  if (has(B01_Q10_DP.FAN_LEVEL)) {
    const fanPower = b01Q7Adapter.windToV1FanPower(b01Q7Adapter.B01_FAMILY.Q10)[
      Number(flat[String(B01_Q10_DP.FAN_LEVEL)])
    ];
    if (fanPower !== undefined) {
      v1.fan_power = fanPower;
    }
  }
  if (has(B01_Q10_DP.CLEAN_MODE)) {
    const cleanType =
      Q10_CLEAN_TYPE_TO_MATTER[Number(flat[String(B01_Q10_DP.CLEAN_MODE)])];
    if (cleanType !== undefined) {
      v1.matter_clean_type = cleanType;
    }
  }
  if (has(B01_Q10_DP.FAULT)) {
    const fault = Number(flat[String(B01_Q10_DP.FAULT)]);
    if (Number.isFinite(fault)) {
      v1.error_code = b01Q7Adapter
        .informationalFaults(b01Q7Adapter.B01_FAMILY.Q10)
        .has(fault)
        ? 0
        : fault;
    }
  }
  return v1;
}

module.exports = {
  mapDpsToV1,
  describeQ10Fault,
  Q10_STATUS_TO_V1_STATE,
  translateQ10StatusToV1State,
  B01_Q10_DP,
  YX_CLEAN_TASK,
  MATTER_TO_Q10_CLEAN_TYPE,
  Q10_CLEAN_TYPE_TO_MATTER,
  translateOutgoing,
  buildDps,
};
