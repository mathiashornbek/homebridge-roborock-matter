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
 * Segment ids out of the several shapes callers use, matching the Q7
 * adapter's own normalisation so the two families accept the same inputs.
 * @param {any} params
 * @returns {number[]}
 */
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
      const roomIds = normalizeSegmentIds(params);
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
 * True when the Q10 dialect can express this v1 method at all.
 * @param {string} method
 * @param {any} [params]
 * @returns {boolean}
 */
function canSendV1Method(method, params) {
  try {
    return Boolean(translateOutgoing(method, params ?? []));
  } catch {
    return false;
  }
}

module.exports = {
  B01_Q10_DP,
  YX_CLEAN_TASK,
  MATTER_TO_Q10_CLEAN_TYPE,
  Q10_CLEAN_TYPE_TO_MATTER,
  translateOutgoing,
  buildDps,
  canSendV1Method,
};
