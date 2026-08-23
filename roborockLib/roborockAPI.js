"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const crypto = require("crypto");

const roborockAuth = require("./lib/roborockAuth");

const rrLocalConnector = require("./lib/localConnector").localConnector;
const roborock_mqtt_connector =
  require("./lib/roborock_mqtt_connector").roborock_mqtt_connector;
const rrMessage = require("./lib/message").message;
const vacuum_class = require("./lib/vacuum").vacuum;
const deviceFeatures = require("./lib/deviceFeatures").deviceFeatures;
const supportsMaxPlusFanPower =
  require("./lib/deviceFeatures").supportsMaxPlusFanPower;
const RRMapParser = require("./lib/RRMapParser");
const messageQueueHandler =
  require("./lib/messageQueueHandler").messageQueueHandler;
const roborockCrypto = require("./lib/roborockCrypto");
const b01Q7Adapter = require("./lib/b01Q7Adapter");

// v1 states in which the robot is actively doing something and state
// transitions are imminent (cleaning, returning, spot/zone/segment runs,
// docking, mop washing). Drives the adaptive B01 poll cadence.
const B01_ACTIVE_V1_STATES = new Set([5, 6, 7, 11, 15, 16, 17, 18, 23, 26]);

// v1 states in which the robot is physically moving through rooms, making
// the SCMap currentPose worth fetching for live-room tracking (cleaning,
// spot/zone/segment runs, going to target). Returning/docking/washing are
// excluded: the live room is static or irrelevant there.
const B01_LIVE_ROOM_FETCH_V1_STATES = new Set([5, 11, 16, 17, 18]);

// v1 states that mark a cleaning run as over for live-room purposes; the
// cached live room is cleared so a later run starts fresh.
const B01_LIVE_ROOM_CLEAR_V1_STATES = new Set([3, 8]);

// The transport-diagnostics fields cloud-only mode owns, and the marker value
// it writes into each.
//
// These diagnostics are persisted, so the markers outlive the setting unless
// something puts them back. `tcpConnectionState` is the one that stuck: it is
// only rewritten when a LAN connection is actually attempted, and none is
// attempted for a robot no local IP was ever discovered for. A user who tried
// cloud-only mode once and switched it off again kept "Cloud only" on the
// device card through restarts, re-pairs and a full plugin reinstall, and the
// diagnostic report told them cloud-only mode was enabled two lines under its
// own `cloudOnlyMode: disabled`.
//
// Setting and clearing both derive from this table on purpose. A hand-written
// list of fields to clear is the same mistake as a hand-written list of files
// or log lines one level up: it is correct until someone adds a fourth marker.
const CLOUD_ONLY_TRANSPORT_MARKERS = Object.freeze({
  lastTransportReason: "cloud-only-mode",
  localDiscoveryState: "disabled",
  tcpConnectionState: "disabled",
});

// The reason recorded for a robot that was marked remote without one being
// given. Deliberately vague: "the vacuum is marked remote" tells the reader
// nothing they did not already know, which is the correct failure mode for a
// missing reason. The alternative — assuming the most common cause — is how
// the report came to state that a LAN connection had been attempted and failed
// for robots the plugin never attempts a LAN connection to.
const UNEXPLAINED_REMOTE_REASON = "remote-device";

// A local socket that completed its TCP handshake and then answered nothing.
// This is a different failure from a connect that failed, and conflating the
// two is what made it invisible: the port is reachable, so nothing looks
// broken, while every request still dies of silence at its timeout.
const LOCAL_MUTE_REMOTE_REASON = "local-socket-connected-but-mute";

// Consecutive local timeouts tolerated before the LAN is written off for a
// robot. One is noise — a single lost frame on a healthy network is ordinary,
// and exiling that robot to the cloud for it would be worse than the bug this
// bound fixes. Three in a row on a socket that keeps reporting itself
// connected is not noise.
const LOCAL_MUTE_TIMEOUT_LIMIT = 3;

// Minimum gap between live-room map fetch attempts while cleaning. The map
// payload is an order of magnitude heavier than get_status, so it rides a
// slower cadence than the active status polls — but 20s meant a robot could
// walk through a whole small room before Apple Home named it, which is the
// opposite of what a "live" room display is for. 10s keeps the map traffic
// modest while making the room track the robot closely enough to be useful.
const B01_LIVE_ROOM_MIN_FETCH_GAP_MS = 10000;

// A live-room fetch that keeps failing is a channel that is down for this
// robot, not a lost frame. The request is heavy, it always rides the cloud
// (get_map_v1 is a secure request), and every failure costs a full request
// timeout. Retrying it at live-display cadence for a whole run buys nothing:
// measured on an a70 whose map channel was timing out, one ten-minute clean
// spent ten guaranteed-to-fail cloud requests and never named a room. So widen
// the gap as failures pile up, and drop straight back to the live cadence the
// moment one answers. The first two failures are deliberately NOT slowed — a
// single lost frame on a healthy channel must not make a working live display
// sluggish, the same rule the local-mute limit follows.
const LIVE_ROOM_FAILURE_BACKOFF_AFTER = 2;
const LIVE_ROOM_FAILURE_BACKOFF_MAX_MS = 300000; // 5 min

/**
 * Required gap before the next live-room fetch attempt, given how many
 * attempts in a row have already failed.
 * @param {number} [consecutiveFailures]
 * @returns {number}
 */
function liveRoomFetchGapMs(consecutiveFailures) {
  const over = Number(consecutiveFailures) - LIVE_ROOM_FAILURE_BACKOFF_AFTER;
  if (!Number.isFinite(over) || over <= 0) {
    return B01_LIVE_ROOM_MIN_FETCH_GAP_MS;
  }
  return Math.min(
    B01_LIVE_ROOM_MIN_FETCH_GAP_MS * 2 ** over,
    LIVE_ROOM_FAILURE_BACKOFF_MAX_MS
  );
}

/**
 * Zero the counters that describe THIS run. clearLiveRoomForDevice runs at
 * every run boundary and its stated job is to stop state leaking into the next
 * run, but it used to drop only the cached room. Everything else survived, so
 * a line reading "attempt N this run" counted every run since Homebridge
 * started, the placeholder explanation meant to be said once per run was only
 * ever visible on the very first run of the process, and "failed N times in a
 * row" could greet a new run's first failure with N already at 5. Resetting
 * has to happen even when no room was ever resolved — a run that failed every
 * attempt is precisely the run that left the counters high.
 * @param {{consecutiveFailures?: number, unresolvedPoseCount?: number, placeholderReported?: boolean} | null | undefined} liveState
 */
function resetLiveRoomRunCounters(liveState) {
  if (!liveState) {
    return;
  }
  liveState.consecutiveFailures = 0;
  liveState.unresolvedPoseCount = 0;
  liveState.placeholderReported = false;
}

// B01/Q7 status cadence. These were literals in three places — the two gap
// values, the loop interval, and a hand-written startup line quoting all
// three. 3.2.0 changed the idle gap from 45s to 25s and the startup line kept
// announcing 45s, so the log contradicted the code for anyone reading it to
// work out why a run took so long to show up. Naming them makes the message
// derivable and the drift impossible.
// Plain-language wording for each way a live-room lookup can come back empty.
// "Between rooms" is only one of them, and it was the only one the log used
// to name — which sent every investigation down the same wrong path.
const B01_LIVE_ROOM_MISS_REASONS = {
  "no-map-header":
    "the map payload had no header, so the position could not be placed on the map",
  "no-pose":
    "the map payload carried no robot position (the robot may not have started moving yet)",
  "no-room-outlines":
    "the map payload carried no room outlines, so there was nothing to match the position against",
  "pose-outside-outlines":
    "the robot's position did not fall inside any known room outline (it may be between rooms, or the map may still be building)",
  // Not a miss the user can do anything about, and not the robot being
  // between rooms: the map payload carried a placeholder where the position
  // should be. Measured at 226 of 227 fetches on a Q7 during a 47-minute
  // clean, always the same cell. See describeLiveRoomResolution.
  "pose-placeholder":
    "the map payload carried a placeholder instead of the robot's position, so this fetch could not place it (the robot sends a real position only on some fetches)",
};

/**
 * The outline range and map origin, appended to a live-room miss.
 *
 * A position cell on its own cannot distinguish "the robot is between rooms"
 * from "the position was computed in the wrong units" — and the field logs
 * showed cells near 22,000 where a Roborock map is a couple of thousand cells
 * at most. Printing the range the outlines occupy, plus the origin and
 * resolution the transform used, makes the difference measurable from one log
 * line instead of inferable from none.
 *
 * @param {{outlineBounds?: {minX: number, minY: number, maxX: number, maxY: number} | null,
 *          head?: {minX: number, minY: number, resolution: number}}} resolution
 * @returns {string}
 */
function describeOutlineBounds(resolution) {
  const bounds = resolution?.outlineBounds;
  if (!bounds) {
    return "";
  }

  const head = resolution.head;
  const origin = head
    ? `, map origin ${head.minX},${head.minY} at ${head.resolution}/cell`
    : "";

  return `, outlines span ${Math.round(bounds.minX)}-${Math.round(bounds.maxX)} x ${Math.round(bounds.minY)}-${Math.round(bounds.maxY)}${origin}`;
}

/**
 * The raw SCMap fields behind a live-room miss.
 *
 * Two Q7s reported a position of exactly (1100, 1100) — the same value on two
 * robots, two maps and twelve minutes of active cleaning. A constant is not a
 * position, so the number being read as the robot's position is not the
 * robot's position.
 *
 * Rather than guess another field number, this prints what the payload
 * actually contains: the size of every top-level field and every scalar in
 * the small ones. Two consecutive lines are then a diff — the value that
 * changed while the robot was driving is the position, and the submessage
 * that grew is the trail it left. That turns the next fix into a reading
 * rather than a fourth guess.
 *
 * @param {{rawSurvey?: {fields?: Array<{field: number, count: number, bytes: number}>,
 *                      scalars?: Record<string, number>,
 *                      truncated?: boolean} | null}} parsed
 * @returns {string}
 */
function describeRawMapFields(parsed) {
  const survey = parsed?.rawSurvey;
  const fields = survey?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return "";
  }

  const shape = fields
    .map(
      (entry) =>
        `${entry.field}:${entry.bytes}B${entry.count > 1 ? `x${entry.count}` : ""}`
    )
    .join(" ");

  const scalars = Object.entries(survey?.scalars || {})
    .map(([path, value]) => `${path}=${formatSurveyScalar(value)}`)
    .join(" ");

  return `, map fields ${shape}${scalars ? `, scalars ${scalars}` : ""}${
    survey?.truncated ? " (truncated)" : ""
  }`;
}

/**
 * A survey value short enough to sit in a log line, precise enough to see a
 * robot move. Three decimals of a metre is a millimetre; three decimals of a
 * millimetre is far below anything a vacuum reports.
 *
 * @param {number} value
 * @returns {string}
 */
function formatSurveyScalar(value) {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

const B01_STATUS_TICK_MS = 15000;
const B01_STATUS_FORCED_GAP_MS = 1500;
const B01_STATUS_ACTIVE_GAP_MS = 12000;
const B01_STATUS_IDLE_GAP_MS = 25000;

// How many keys of an arbitrary diagnostic object survive compaction.
const DIAGNOSTIC_KEY_LIMIT = 30;

// Keys that are always kept, however far down the payload they sit. These are
// the ones a support round-trip actually turns on: what the robot is doing,
// what it thinks is wrong, and the state of the dock's consumables.
const DIAGNOSTIC_PRIORITY_KEYS = new Set([
  "state",
  "error_code",
  "fault",
  "dock_error_status",
  "dock_type",
  "battery",
  "charge_status",
  "water_box_status",
  "water_box_carriage_status",
  "water_shortage_status",
  "water_box_mode",
  "dust_collection_status",
  "mop_mode",
  "in_cleaning",
  "in_returning",
  "map_present",
  "fan_power",
]);

// Scheduler granularity for the classic (v1-protocol) status refresh. The
// refresh itself is throttled per robot inside vacuum.getParameter, so this
// only decides how promptly that window is noticed — a 1-second tick meant
// ~86k wake-ups per robot per day to serve at most 1440 polls.
const CLASSIC_STATUS_TICK_MS = 15000;

// Persisted states whose disk flush is debounced (see setStateAsync): they
// change on every received robot message, are served from memory, and only
// need the on-disk copy for restart survival.
const DEBOUNCED_PERSIST_IDS = new Set([
  "TransportDiagnostics",
  "RoborockDiagnostics",
]);
const PERSIST_FLUSH_DEBOUNCE_MS = 60000;

const PERSISTED_STATE_IDS = new Set([
  "UserData",
  "clientID",
  "HomeData",
  "RoomMappings",
  "B01Rooms",
  "TransportDiagnostics",
  "RoborockDiagnostics",
]);

const dockingStationStates = [
  "cleanFluidStatus",
  "waterBoxFilterStatus",
  "dustBagStatus",
  "dirtyWaterBoxStatus",
  "clearWaterBoxStatus",
  "isUpdownWaterReady",
];

// Commands that are forwarded to vacuums[duid].command() as-is, without any
// command-specific handling in startCommand.
const SIMPLE_VACUUM_COMMANDS = new Set([
  "app_zoned_clean",
  "app_goto_target",
  "app_start",
  "app_stop",
  "stop_zoned_clean",
  "app_pause",
  "app_charge",
  "find_me",
  "app_segment_clean_by_ids",
  "load_multi_map",
]);

const TRANSIENT_ERROR_LOG_THROTTLE_MS = 6 * 60 * 60 * 1000;
const MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS = 2000;
// Reserved out of the caller's prep window so the sequence ends by itself and
// reports what it could not confirm, rather than being cut off mid-command with
// nothing said. See createMatterCleanModePrepBudget.
const MATTER_CLEAN_MODE_PREP_MARGIN_MS = 250;
// The prep labels that carry the user's clean TYPE, as opposed to a level
// inside it. On a v1 robot the difference between "Vacuum" and "Vacuum and mop"
// IS the water-box mode; on the Q7/B01 dialect it is the native clean type.
// The suction level is deliberately absent: a cosmetic command that did not
// answer says nothing about which type the robot is running.
//
// Named here, once, because both ends need the same answer — the prep decides
// what to report as unconfirmed and the caller decides whether it may still
// outrank the robot's own report. Two hand-written copies drifting apart is the
// most repeated defect in this codebase.
const MATTER_CLEAN_TYPE_PREP_LABELS = new Set(["water mode", "clean type"]);
// How long to wait before retrying to cache rooms for a saved map that did not
// return room segments. Retrying lets newly named/segmented maps appear without
// switching maps on every poll cycle.
const SERVICE_AREA_ROOM_MAP_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

class Roborock {
  constructor(options) {
    this.bInited = false;

    this.config = {
      ...options,
      cloudOnlyMode: Boolean(options.cloudOnlyMode),
    };

    this.updateInterval = options.updateInterval || 180;
    this.log = options.log || console;
    this.language = options.language || "en";

    this.localKeys = null;
    this.localL01Nonces = new Map();
    this.roomIDs = {};
    this.vacuums = {};
    this.initializedVacuumDuids = new Set();
    this.socket = null;

    this.objects = {};
    this.states = {};
    this.roomMappings = this.getPersistedRoomMappings();

    this.idCounter = 0;
    this.nonce = crypto.randomBytes(16);
    this.messageQueue = new Map();

    this.localConnector = new rrLocalConnector(this);
    this.rr_mqtt_connector = new roborock_mqtt_connector(this);
    this.message = new rrMessage(this);

    this.messageQueueHandler = new messageQueueHandler(this);

    this.pendingRequests = new Map();

    this.localDevices = {};
    this.remoteDevices = new Set();
    // Why each of those robots is remote. Membership alone cannot answer that:
    // see markDeviceRemote.
    /** @type {Map<string, string>} */
    this.remoteDeviceReasons = new Map();
    // Consecutive local request timeouts per robot, counted only while the
    // local client still reports itself connected. Reset by any local reply:
    // the count has to mean "this socket answers nothing", not "this socket has
    // ever timed out".
    /** @type {Map<string, number>} */
    this.localMuteTimeouts = new Map();

    this.name = "roborock";
    this.deviceNotify = null;
    this.serviceAreaRoomMapRefreshAttempts = new Map();
    this.matterUnsupportedSettingCommands = new Set();
    // Poll commands a robot has answered with "unsupported"/"unknown method":
    // remembered per device (until restart) so exotic models stop generating
    // repeated warnings for requests they will never answer.
    this.unsupportedPollCommands = new Set();
    this.loggedPollProfiles = new Set();
    this.skippedDialectPolls = new Set();
    this.baseURL = options.baseURL || "usiot.roborock.com";

    this.userData = options.userData || null;
    this.authState = {
      twoFactorRequired: false,
      statusMessage: "",
    };
    this.pendingAuth = null;
    this.persistBasePath = null;
    this.errorLogThrottleMs =
      typeof options.errorLogThrottleMs === "number"
        ? options.errorLogThrottleMs
        : TRANSIENT_ERROR_LOG_THROTTLE_MS;
    this.errorLogThrottle = new Map();
    this.now =
      typeof options.now === "function" ? options.now : () => Date.now();
  }

  isInited() {
    return this.bInited;
  }

  isCloudOnlyModeEnabled() {
    return Boolean(this.config.cloudOnlyMode);
  }

  getKnownLocalIp(duid) {
    if (this.localDevices && typeof this.localDevices[duid] == "string") {
      return this.localDevices[duid];
    }

    const diagnostics = this.getTransportDiagnostics();
    const diagnosticEntry =
      diagnostics && typeof diagnostics[duid] == "object"
        ? diagnostics[duid]
        : null;
    if (
      diagnosticEntry &&
      typeof diagnosticEntry.localIp == "string" &&
      diagnosticEntry.localIp
    ) {
      return diagnosticEntry.localIp;
    }

    const networkInfo = this.getStateAsync(`Devices.${duid}.networkInfo.ip`);
    if (networkInfo && typeof networkInfo.val == "string" && networkInfo.val) {
      return networkInfo.val;
    }

    return null;
  }

  async ensureLocalConnection(duid) {
    if (this.isCloudOnlyModeEnabled()) {
      return false;
    }

    if (this.localConnector.isConnected(duid)) {
      return true;
    }

    const localIp = this.getKnownLocalIp(duid);
    if (!localIp) {
      await this.updateTransportDiagnostics(duid, {
        localDiscoveryState: "not-discovered",
        lastTransportReason: "missing-local-ip",
      });
      return false;
    }

    await this.localConnector.ensureConnected(duid, localIp);
    return Boolean(this.localConnector.isConnected(duid));
  }

  setInterval(callback, interval, ...args) {
    return setInterval(() => callback(...args), interval);
  }

  clearInterval(interval) {
    clearInterval(interval);
  }

  setTimeout(callback, timeout, ...args) {
    return setTimeout(() => callback(...args), timeout);
  }

  clearTimeout(timeout) {
    clearTimeout(timeout);
  }

  //dummy function for calling setObjectNotExistsAsync
  async setObjectNotExistsAsync(id, obj) {}

  //dummy function for calling setObjectAsync
  async setObjectAsync(id, obj) {}

  //dummy function for calling getObjectAsync
  async getObjectAsync(id) {}

  //dummy function for calling delObjectAsync
  async delObjectAsync(id) {}

  getStateAsync(id) {
    try {
      if (PERSISTED_STATE_IDS.has(id)) {
        // Cache persisted state in memory after the first disk read so repeated
        // reads (HomeData, RoomMappings, TransportDiagnostics) do not re-read and
        // re-parse the file on every status lookup or command. setStateAsync and
        // deleteStateAsync keep this cache in sync with the persisted file.
        if (Object.prototype.hasOwnProperty.call(this.states, id)) {
          return this.states[id];
        }

        const loaded = this.readPersistedState(id);
        this.states[id] = loaded;
        return loaded;
      }

      return this.states[id];
    } catch (error) {
      if (error && error.code == "ENOENT") {
        return null;
      }
      this.log.error(`getStateAsync: ${error}`);
    }

    return null;
  }

  readPersistedState(id) {
    const persistPath = this.getPersistPath(id);
    if (fs.existsSync(persistPath)) {
      return JSON.parse(fs.readFileSync(persistPath, "utf8"));
    }

    const legacyPath = this.getLegacyPersistPath(id);
    if (legacyPath && fs.existsSync(legacyPath)) {
      const legacyState = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      this.tryMigrateLegacyStateFile(id, legacyState, legacyPath, persistPath);
      return legacyState;
    }

    return null;
  }

  async setStateAsync(id, state) {
    try {
      if (PERSISTED_STATE_IDS.has(id)) {
        // Chatty diagnostic states update on every received robot message
        // (every few seconds while cleaning). They are read from memory by
        // the settings UI; the on-disk copy only needs to survive restarts.
        // Debouncing their disk flush to once per minute turns one
        // SYNCHRONOUS write per robot message into at most one per minute
        // — a real win for event-loop latency and SD-card wear on
        // Raspberry Pi installs. Critical states (credentials, HomeData,
        // room caches) still persist immediately.
        if (DEBOUNCED_PERSIST_IDS.has(id)) {
          this.states[id] = state;
          this.schedulePersistFlush(id);
          return;
        }
        const persistPath = this.getPersistPath(id);
        // UserData holds the cloud token and the rriot block (including the
        // HMAC key that signs every API request); HomeData holds every
        // robot's localKey. Those are exactly as sensitive as the AES key in
        // src/crypto.ts, which is already written 0600 — writing them
        // world-readable made that encryption pointless on any host with a
        // second user or service account.
        this.writeSecurePersistFile(
          persistPath,
          JSON.stringify(state, null, 2)
        );
      }

      this.states[id] = state;

      if (this.deviceNotify && (id == "HomeData" || id == "CloudMessage")) {
        this.deviceNotify(id, state);
      }
    } catch (error) {
      if (PERSISTED_STATE_IDS.has(id) && error && error.code == "EACCES") {
        try {
          const fallbackPath = path.join(
            this.forceTemporaryPersistPath(),
            `roborock.${id}`
          );
          this.writeSecurePersistFile(
            fallbackPath,
            JSON.stringify(state, null, 2)
          );
          this.states[id] = state;
          this.log.warn(
            `Write access denied for persistent state. Saved '${id}' in temporary path '${fallbackPath}'.`
          );
          return;
        } catch (fallbackError) {
          this.log.error(`setStateAsync fallback failed: ${fallbackError}`);
        }
      }
      this.log.error(`setStateAsync: ${error}`);
    }
  }

  async setStateChangedAsync(id, state) {
    await this.setStateAsync(id, state);
  }

  async deleteStateAsync(id) {
    try {
      if (PERSISTED_STATE_IDS.has(id)) {
        const persistPath = this.getPersistPath(id);
        if (fs.existsSync(persistPath)) {
          fs.unlinkSync(persistPath);
        }

        const legacyPath = this.getLegacyPersistPath(id);
        if (
          legacyPath &&
          legacyPath !== persistPath &&
          fs.existsSync(legacyPath)
        ) {
          fs.unlinkSync(legacyPath);
        }
      }

      delete this.states[id];
    } catch (error) {
      this.log.error(`deleteStateAsync: ${error}`);
    }
  }

  subscribeStates(id) {
    this.log.debug(`subscribeStates: ${id}`);
  }

  getPersistPath(id) {
    const basePath = this.resolvePersistBasePath();
    return path.join(basePath, `roborock.${id}`);
  }

  resolvePersistBasePath() {
    if (this.persistBasePath) {
      return this.persistBasePath;
    }

    const candidates = [];
    if (this.config.storagePath) {
      candidates.push(this.config.storagePath);
    }
    if (process.env.HOMEBRIDGE_STORAGE_PATH) {
      candidates.push(process.env.HOMEBRIDGE_STORAGE_PATH);
    }
    candidates.push(path.resolve(__dirname, "./data"));
    candidates.push(path.join(os.tmpdir(), "homebridge-roborock-vacuum"));

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      try {
        const resolved = path.resolve(candidate);
        fs.mkdirSync(resolved, { recursive: true });
        fs.accessSync(resolved, fs.constants.W_OK);
        this.persistBasePath = resolved;
        return this.persistBasePath;
      } catch (error) {
        this.log.debug(
          `Persist path candidate '${candidate}' is not writable: ${error.message}`
        );
      }
    }

    return this.forceTemporaryPersistPath();
  }

  forceTemporaryPersistPath() {
    const emergencyPath = path.join(os.tmpdir(), "homebridge-roborock-vacuum");
    fs.mkdirSync(emergencyPath, { recursive: true });
    this.persistBasePath = emergencyPath;
    this.log.warn(`Using emergency temporary persist path '${emergencyPath}'.`);
    return this.persistBasePath;
  }

  getLegacyPersistPath(id) {
    if (this.config.storagePath) {
      return path.join(this.config.storagePath, `roborock.${id}`);
    }

    return path.resolve(__dirname, `./data/${id}`);
  }

  tryMigrateLegacyStateFile(id, state, legacyPath, persistPath) {
    if (!state || !legacyPath || !persistPath || legacyPath === persistPath) {
      return;
    }

    try {
      this.writeSecurePersistFile(persistPath, JSON.stringify(state, null, 2));
      this.log.info(
        `Migrated legacy '${id}' state file from '${legacyPath}' to '${persistPath}'.`
      );
    } catch (error) {
      this.log.debug(
        `Failed to migrate legacy '${id}' state file: ${error.message}`
      );
    }
  }

  parseSkipDevices(value) {
    if (!value) {
      return [];
    }
    if (Array.isArray(value)) {
      return value.map((entry) => `${entry}`.trim()).filter((entry) => entry);
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry);
    }
    return [];
  }

  shouldSkipDevice(device, ignoredSet) {
    if (!device || !ignoredSet) {
      return false;
    }

    return [device.sn, device.duid]
      .filter((value) => value !== undefined && value !== null)
      .some((value) => ignoredSet.has(`${value}`.trim()));
  }

  getIgnoredDeviceSet() {
    // Cache on the raw config values; "|| []" fallbacks would mint a fresh
    // array per call and defeat identity-based invalidation.
    const rawIgnored = this.config.ignoredDevices;
    const rawSkip = this.config.skipDevices;

    if (
      this._ignoredSetCache &&
      this._ignoredSetCacheDeps &&
      this._ignoredSetCacheDeps.rawIgnored === rawIgnored &&
      this._ignoredSetCacheDeps.rawSkip === rawSkip
    ) {
      return this._ignoredSetCache;
    }

    const ignoredSet = new Set([
      ...(rawIgnored || []),
      ...this.parseSkipDevices(rawSkip),
    ]);
    this._ignoredSetCache = ignoredSet;
    this._ignoredSetCacheDeps = { rawIgnored, rawSkip };
    return ignoredSet;
  }

  normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  getStoredHomeData() {
    const homedata = this.getStateAsync("HomeData");

    if (homedata && typeof homedata.val == "string") {
      // HomeData is tens of kilobytes and this getter sits in hot paths
      // (every Matter attribute read and cluster build resolves device data
      // through it). Parse once per distinct payload instead of on every
      // call; callers never mutate the returned object.
      if (
        homedata.val === this._homeDataParseKey &&
        this._homeDataParsed !== undefined
      ) {
        return this._homeDataParsed;
      }

      const parsed = JSON.parse(homedata.val);
      this._homeDataParseKey = homedata.val;
      this._homeDataParsed = parsed;
      return parsed;
    }

    return null;
  }

  getAllHomeDevices(homedata) {
    const homeDataSource = homedata || this.getStoredHomeData();
    if (!homeDataSource) {
      return [];
    }

    // Enforce the skip list at the source so every consumer — accessory
    // discovery (HomeKit and Matter), read paths, local-key refresh — sees a
    // consistent device set. Previously only the login-time runtime list was
    // filtered, so skipped robots still had accessories published for them
    // with no runtime behind them. The plugin UI reads the HomeData file
    // directly, so skipped robots remain visible there for re-enabling.
    const ignoredSet = this.getIgnoredDeviceSet();
    return this.normalizeArray(homeDataSource.devices)
      .concat(this.normalizeArray(homeDataSource.receivedDevices))
      .filter((device) => !this.shouldSkipDevice(device, ignoredSet));
  }

  getManagedHomeDevices(homedata, ignoredSet = this.getIgnoredDeviceSet()) {
    return this.getAllHomeDevices(homedata).filter((device) => {
      return (
        device && device.duid && !this.shouldSkipDevice(device, ignoredSet)
      );
    });
  }

  getLocalKeyDevices(homedata, ignoredSet = this.getIgnoredDeviceSet()) {
    return this.getManagedHomeDevices(homedata, ignoredSet).filter((device) => {
      if (!device || !device.duid || !device.localKey) {
        return false;
      }

      if (device.sn && ignoredSet.has(device.sn)) {
        return false;
      }

      return true;
    });
  }

  async refreshLocalKeysFromHomeData(
    homedata,
    ignoredSet = this.getIgnoredDeviceSet()
  ) {
    const localKeyDevices = this.getLocalKeyDevices(homedata, ignoredSet);
    const previousKeys =
      this.localKeys instanceof Map ? this.localKeys : new Map();
    const nextKeys = new Map(
      localKeyDevices.map((device) => [device.duid, device.localKey])
    );

    this.localKeys = nextKeys;

    for (const device of localKeyDevices) {
      const previousKey = previousKeys.get(device.duid);
      if (!previousKey || previousKey === device.localKey) {
        continue;
      }

      this.log.debug(
        `Roborock local key changed for ${device.name || device.duid}; resetting LAN TCP connection so local commands use the fresh credentials.`
      );
      if (typeof this.localConnector.resetClient == "function") {
        await this.localConnector.resetClient(device.duid, "local-key-changed");
      }

      const localIp = this.localDevices?.[device.duid];
      if (!this.isCloudOnlyModeEnabled() && localIp) {
        await this.localConnector.createClient(device.duid, localIp);
      }
    }

    for (const duid of previousKeys.keys()) {
      if (nextKeys.has(duid)) {
        continue;
      }

      if (typeof this.localConnector.resetClient == "function") {
        await this.localConnector.resetClient(duid, "missing-local-key");
      }
    }

    return localKeyDevices;
  }

  updateRoomMappingCache(duid, mapId, mappedRooms) {
    if (!duid) {
      return;
    }

    const normalizedMapId = Number(mapId);
    const roomMapId = Number.isFinite(normalizedMapId) ? normalizedMapId : null;
    const entry = this.ensureRoomMappingEntry(duid);
    const rooms = [];
    const seenSegments = new Set();

    for (const mappedRoom of this.normalizeArray(mappedRooms)) {
      if (!Array.isArray(mappedRoom) || mappedRoom.length < 2) {
        continue;
      }

      const segmentId = Number(mappedRoom[0]);
      const roomId = Number(mappedRoom[1]);
      if (!Number.isInteger(segmentId) || segmentId < 0) {
        continue;
      }
      if (seenSegments.has(segmentId)) {
        continue;
      }

      seenSegments.add(segmentId);
      rooms.push({
        segmentId,
        roomId: Number.isFinite(roomId) ? roomId : mappedRoom[1],
        mapId: roomMapId,
        name: this.roomIDs[mappedRoom[1]] || `Room ${mappedRoom[1]}`,
      });
    }

    entry.mapId = roomMapId;
    entry.currentMapId = roomMapId;
    entry.roomsByMap[this.getRoomMappingMapKey(roomMapId)] = rooms;
    entry.rooms = this.getFlattenedRoomMappings(entry);
    entry.updatedAt = new Date().toISOString();
    this.ensureMapListEntry(entry, roomMapId);
    this.persistRoomMappings();

    if (this.deviceNotify) {
      this.deviceNotify("RoomMapping", {
        duid,
        mapId: entry.mapId,
        rooms,
      });
    }
  }

  updateMapListCache(duid, mapInfo) {
    if (!duid) {
      return;
    }

    const maps = [];
    const seenMapIds = new Set();
    const mapEntries = Array.isArray(mapInfo)
      ? mapInfo
      : mapInfo && typeof mapInfo === "object"
        ? Object.values(mapInfo)
        : [];

    for (const map of mapEntries) {
      const mapRecord = map && typeof map === "object" ? map : null;
      const mapId = Number(mapRecord?.mapFlag);
      if (!Number.isInteger(mapId) || mapId < 0 || seenMapIds.has(mapId)) {
        continue;
      }

      const normalizedName =
        typeof mapRecord.name === "string" ? mapRecord.name.trim() : "";
      seenMapIds.add(mapId);
      maps.push({
        mapId,
        name: normalizedName || `Roborock Map ${mapId}`,
      });
    }

    const entry = this.ensureRoomMappingEntry(duid);
    if (maps.length > 0) {
      entry.maps = maps;
    }
    entry.updatedAt = new Date().toISOString();
    this.ensureMapListEntry(entry, entry.currentMapId ?? entry.mapId ?? null);
    this.persistRoomMappings();

    if (this.deviceNotify) {
      this.deviceNotify("RoomMapping", {
        duid,
        mapId: entry.mapId ?? null,
        rooms: this.getFlattenedRoomMappings(entry),
      });
    }
  }

  getRoomMappingsForDevice(duid) {
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      return this.getB01RoomCache(duid).map((room) => ({
        segmentId: room.roomId,
        mapId: 0,
        name: room.roomName || `Room ${room.roomId}`,
      }));
    }

    const mapping = this.roomMappings[duid];
    if (!mapping) {
      return [];
    }

    return this.getFlattenedRoomMappings(mapping).map((room) => ({ ...room }));
  }

  getRoomMappingsForMap(duid, mapId) {
    const mapping = this.roomMappings[duid];
    if (!mapping || !mapping.roomsByMap) {
      return [];
    }

    const rooms = mapping.roomsByMap[this.getRoomMappingMapKey(mapId)];
    return this.normalizeArray(rooms).map((room) => ({ ...room }));
  }

  getMapListForDevice(duid) {
    const mapping = this.roomMappings[duid];
    if (!mapping || !Array.isArray(mapping.maps)) {
      return [];
    }

    return mapping.maps.map((map) => ({ ...map }));
  }

  getCurrentMapIdForDevice(duid) {
    // B01/Q7 rooms are always fetched from the robot's CURRENT map (the
    // `cur` flag in service.get_map_list), and the cache exposes them under
    // the canonical mapId 0. Reporting 0 here keeps the Matter room-clean
    // flow from attempting a map switch (load_multi_map has no Q7
    // equivalent) before sending the segment command.
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      return 0;
    }

    const mapping = this.roomMappings[duid];
    if (!mapping) {
      return null;
    }

    return mapping.currentMapId ?? mapping.mapId ?? null;
  }

  getPersistedRoomMappings() {
    const cached = this.getStateAsync("RoomMappings");
    const value = cached?.val;

    if (!value) {
      return {};
    }

    try {
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch (error) {
      this.log.debug(`Failed to parse persisted room mappings: ${error}`);
      return {};
    }
  }

  ensureRoomMappingEntry(duid) {
    const existing = this.roomMappings[duid] || {};
    if (!existing.roomsByMap) {
      existing.roomsByMap = {};
    }
    if (!Array.isArray(existing.maps)) {
      existing.maps = [];
    }

    this.roomMappings[duid] = existing;
    return existing;
  }

  ensureMapListEntry(entry, mapId) {
    if (mapId === null || mapId === undefined) {
      return;
    }

    if (!Array.isArray(entry.maps)) {
      entry.maps = [];
    }

    if (!entry.maps.some((map) => map.mapId === mapId)) {
      entry.maps.push({
        mapId,
        name: `Roborock Map ${mapId}`,
      });
    }
  }

  getFlattenedRoomMappings(mapping) {
    if (mapping.roomsByMap && typeof mapping.roomsByMap === "object") {
      return Object.values(mapping.roomsByMap).flatMap((rooms) =>
        this.normalizeArray(rooms)
      );
    }

    return this.normalizeArray(mapping.rooms);
  }

  getRoomMappingMapKey(mapId) {
    return mapId === null || mapId === undefined ? "none" : String(mapId);
  }

  persistRoomMappings() {
    void this.setStateAsync("RoomMappings", {
      val: JSON.stringify(this.roomMappings),
      ack: true,
    });
  }

  /**
   * Reconcile one robot's cloud-only transport markers with the mode as it is
   * configured right now.
   *
   * Enabling stamps every marker in CLOUD_ONLY_TRANSPORT_MARKERS. Disabling
   * clears exactly those fields that still hold the marker value, so a LAN
   * connection that came up in the meantime is never stomped, and a robot that
   * has no diagnostics yet is not given any.
   *
   * @param {string} duid
   * @param {boolean} cloudOnly
   */
  async syncCloudOnlyTransportMarkers(duid, cloudOnly) {
    if (!duid) {
      return;
    }

    if (cloudOnly) {
      await this.updateTransportDiagnostics(duid, {
        ...CLOUD_ONLY_TRANSPORT_MARKERS,
      });
      return;
    }

    const entry = this.getTransportDiagnostics()[duid];
    if (!entry || typeof entry != "object") {
      return;
    }

    const cleared = {};
    for (const [field, marker] of Object.entries(
      CLOUD_ONLY_TRANSPORT_MARKERS
    )) {
      if (entry[field] === marker) {
        cleared[field] = null;
      }
    }

    if (Object.keys(cleared).length) {
      await this.updateTransportDiagnostics(duid, cleared);
    }
  }

  getTransportDiagnostics() {
    const diagnostics = this.getStateAsync("TransportDiagnostics");
    if (diagnostics && typeof diagnostics.val == "string") {
      try {
        return JSON.parse(diagnostics.val);
      } catch (error) {
        this.log.debug(
          `Failed to parse transport diagnostics state: ${error.message}`
        );
      }
    }

    return {};
  }

  getRoborockDiagnostics() {
    const diagnostics = this.getStateAsync("RoborockDiagnostics");
    if (diagnostics && typeof diagnostics.val == "string") {
      try {
        return JSON.parse(diagnostics.val);
      } catch (error) {
        this.log.debug(
          `Failed to parse Roborock diagnostics state: ${error.message}`
        );
      }
    }

    return {};
  }

  async updateRoborockDiagnostics(duid, key, payload) {
    if (!duid || !key) {
      return;
    }

    const diagnostics = this.getRoborockDiagnostics();
    const currentEntry =
      diagnostics[duid] && typeof diagnostics[duid] === "object"
        ? diagnostics[duid]
        : {};

    diagnostics[duid] = {
      ...currentEntry,
      [key]: this.compactDiagnosticPayload(payload),
      updatedAt: new Date().toISOString(),
    };

    await this.setStateAsync("RoborockDiagnostics", {
      val: JSON.stringify(diagnostics),
      ack: true,
    });
  }

  recordRoborockDiagnosticMessage(source, message) {
    if (source !== "CloudMessage" && source !== "LocalMessage") {
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return;
    }

    const { duid, payload } = message;
    if (!duid || payload === undefined) {
      return;
    }

    const key =
      source === "CloudMessage" ? "lastCloudMessage" : "lastLocalMessage";
    void this.updateRoborockDiagnostics(String(duid), key, {
      source,
      receivedAt: new Date().toISOString(),
      payload,
    });
  }

  compactDiagnosticPayload(value, depth = 0) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 500)}...` : value;
    }

    if (typeof value !== "object") {
      return value;
    }

    if (depth >= 3) {
      return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
    }

    if (Array.isArray(value)) {
      const compactArray = value
        .slice(0, 8)
        .map((entry) => this.compactDiagnosticPayload(entry, depth + 1));
      if (value.length > compactArray.length) {
        compactArray.push(`[truncated:${value.length - compactArray.length}]`);
      }
      return compactArray;
    }

    const compactObject = {};
    const entries = Object.entries(value);
    let kept = 0;
    for (const [key, entryValue] of entries) {
      // A get_status payload runs to about 50 keys, and the first 30 are
      // mostly housekeeping — so the flat cap used to drop dock_error_status,
      // water_shortage_status and friends, i.e. exactly the fields a fault
      // report is about. Keep the cap for everything else, but never let it
      // truncate away the ones diagnostics exist to answer.
      if (kept >= DIAGNOSTIC_KEY_LIMIT && !DIAGNOSTIC_PRIORITY_KEYS.has(key)) {
        continue;
      }
      kept += 1;

      if (this.isSensitiveDiagnosticKey(key)) {
        compactObject[key] = "[redacted]";
        continue;
      }

      compactObject[key] = this.compactDiagnosticPayload(entryValue, depth + 1);
    }

    if (entries.length > Object.keys(compactObject).length) {
      compactObject.__truncatedKeys =
        entries.length - Object.keys(compactObject).length;
    }

    return compactObject;
  }

  isSensitiveDiagnosticKey(key) {
    return /token|localkey|local_key|password|secret|rriot|key/i.test(
      String(key)
    );
  }

  async updateTransportDiagnostics(duid, patch) {
    if (!duid || !patch || typeof patch !== "object") {
      return;
    }

    const diagnostics = this.getTransportDiagnostics();
    const currentEntry =
      diagnostics[duid] && typeof diagnostics[duid] === "object"
        ? diagnostics[duid]
        : {};

    diagnostics[duid] = {
      ...currentEntry,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await this.setStateAsync("TransportDiagnostics", {
      val: JSON.stringify(diagnostics),
      ack: true,
    });

    this.logTransportDiagnosticsChange(
      duid,
      currentEntry,
      diagnostics[duid],
      patch
    );
  }

  logTransportDiagnosticsChange(duid, previous, current, patch) {
    const message = this.buildTransportDiagnosticsLogMessage(
      duid,
      previous || {},
      current || {},
      patch || {}
    );

    if (message) {
      this.log.debug(message);
    }
  }

  buildTransportDiagnosticsLogMessage(duid, previous, current, patch) {
    const deviceLabel = this.formatDeviceForTransportLog(duid);
    const method =
      current.lastCommandMethod || patch.lastCommandMethod || "unknown method";

    const changed = (field) =>
      Object.prototype.hasOwnProperty.call(patch, field) &&
      previous[field] !== current[field];

    if (changed("tcpConnectionState")) {
      return this.describeTcpTransportChange(deviceLabel, current);
    }

    if (changed("isRemote") || changed("remoteReason")) {
      return this.describeRemoteTransportChange(deviceLabel, current);
    }

    if (changed("online")) {
      return current.online
        ? `Roborock reports ${deviceLabel} is online again; local transport can resume when TCP is connected.`
        : `Roborock reports ${deviceLabel} is offline; commands will wait or fall back to cloud when possible.`;
    }

    if (changed("localIp")) {
      return `Discovered local IP ${this.formatLocalIpForLog(current.localIp)} for ${deviceLabel}; LAN TCP connection can be attempted.`;
    }

    if (changed("localDiscoveryState")) {
      return this.describeLocalDiscoveryChange(deviceLabel, current);
    }

    if (changed("lastTransport") || changed("lastTransportReason")) {
      return this.describeTransportRouteChange(
        deviceLabel,
        previous,
        current,
        method
      );
    }

    return null;
  }

  describeTcpTransportChange(deviceLabel, current) {
    const ip = this.formatLocalIpForLog(current.localIp);
    const reason = this.describeTransportReason(current.lastTransportReason);

    switch (current.tcpConnectionState) {
      case "connecting":
        return `Opening local LAN TCP connection to ${deviceLabel}${ip ? ` at ${ip}` : ""}.`;
      case "connected":
        return `Local LAN TCP connected to ${deviceLabel}${ip ? ` at ${ip}` : ""}; commands can use local transport.`;
      case "disabled":
        return `Local LAN TCP disabled for ${deviceLabel}; using Roborock cloud transport because ${reason}.`;
      case "connect-failed":
        return `Local LAN TCP connection failed for ${deviceLabel}${ip ? ` at ${ip}` : ""}; ${reason}. Cloud transport will be used when available.`;
      case "disconnected":
        return `Local LAN TCP disconnected for ${deviceLabel}; cloud fallback will be used until local reconnects.`;
      case "error":
        return `Local LAN TCP error for ${deviceLabel}; ${reason}. Cloud fallback will be used when available.`;
      default:
        return `Local LAN TCP state for ${deviceLabel} changed to ${current.tcpConnectionState || "unknown"}.`;
    }
  }

  describeRemoteTransportChange(deviceLabel, current) {
    if (current.isRemote) {
      const reason = current.remoteReason || "remote-device";
      return `Using Roborock cloud transport for ${deviceLabel} because ${this.describeTransportReason(reason)}.`;
    }

    return `${deviceLabel} is no longer marked remote; local transport may be used when credentials and TCP are available.`;
  }

  describeLocalDiscoveryChange(deviceLabel, current) {
    if (current.localDiscoveryState === "disabled") {
      return `Local discovery disabled for ${deviceLabel}; using Roborock cloud transport because ${this.describeTransportReason(current.lastTransportReason)}.`;
    }

    if (current.localDiscoveryState === "not-discovered") {
      return `No local IP is cached for ${deviceLabel}; the plugin will use cloud transport until discovery succeeds.`;
    }

    return `Local discovery for ${deviceLabel} changed to ${current.localDiscoveryState || "unknown"}.`;
  }

  describeTransportRouteChange(deviceLabel, previous, current, method) {
    const reason = this.describeTransportReason(current.lastTransportReason);

    if (current.lastTransport === "local") {
      if (previous.lastTransport === "cloud") {
        return `Local transport recovered for ${deviceLabel}; using LAN TCP for ${method} because ${reason}.`;
      }

      return `Using local LAN transport for ${deviceLabel} (${method}) because ${reason}.`;
    }

    if (current.lastTransport === "cloud") {
      if (this.isCloudOnlyTransportReason(current.lastTransportReason)) {
        return `Using Roborock cloud transport for ${deviceLabel} (${method}) because ${reason}.`;
      }

      if (previous.lastTransport === "local") {
        return `Falling back from local LAN to Roborock cloud for ${deviceLabel} (${method}) because ${reason}.`;
      }

      return `Using Roborock cloud transport for ${deviceLabel} (${method}) because ${reason}.`;
    }

    if (current.lastTransport === "local-pending") {
      return `Preparing local LAN transport for ${deviceLabel}; waiting for TCP connection.`;
    }

    return null;
  }

  isCloudOnlyTransportReason(reason) {
    return [
      "cloud-only-mode",
      "cloud-only-mqtt-unavailable",
      "network-info-cloud-only",
      "secure-command",
      "photo-command",
      "preferred-cloud-command",
      // Not a fallback from local: this dialect has no local to fall back from.
      b01Q7Adapter.B01_CLOUD_ONLY_REMOTE_REASON,
    ].includes(String(reason));
  }

  describeTransportReason(reason) {
    const reasons = {
      "cloud-only-mode": "cloud-only mode is enabled",
      "cloud-only-mqtt-unavailable":
        "cloud-only mode is enabled but Roborock cloud MQTT is unavailable",
      "cloud-request": "cloud transport was selected for this command",
      "device-offline": "Roborock currently reports the vacuum offline",
      "device-offline-during-connect":
        "Roborock reported the vacuum offline while opening the local TCP connection",
      "local-request": "an active LAN TCP connection is available",
      "local-socket-unavailable":
        "the local TCP socket was unavailable when the command was requested",
      "local-unavailable-fallback":
        "the local TCP socket was not connected when the command was requested",
      "missing-local-ip": "no local IP address is cached for this vacuum",
      "missing-local-key": "no local credential is cached for this vacuum",
      "mqtt-unavailable": "the Roborock cloud MQTT connection is unavailable",
      "network-info-cloud-only":
        "Roborock network information must be fetched through the cloud",
      "photo-command": "photo requests require Roborock cloud transport",
      "preferred-cloud-command":
        "Matter commands are configured to prefer Roborock cloud transport",
      "received-device":
        "the vacuum is shared into this account as a received device",
      "remote-device": "the vacuum is marked remote",
      "secure-command": "this secure command requires Roborock cloud transport",
      "tcp-connected": "the local TCP socket connected successfully",
      "tcp-connect-failed": "opening the local TCP socket failed",
      "tcp-disconnected": "the local TCP socket disconnected",
      "udp-broadcast-discovery": "UDP broadcast discovery found the vacuum",
      "marked-remote-after-connect-failure":
        "local TCP connection failed and the vacuum was marked remote",
      [LOCAL_MUTE_REMOTE_REASON]:
        "the local TCP socket connected but the vacuum answered nothing on it, so the cloud is used instead",
      [b01Q7Adapter.B01_CLOUD_ONLY_REMOTE_REASON]:
        "this model speaks only Roborock's cloud protocol, which has no LAN control surface",
    };

    if (!reason) {
      return "no transport reason was recorded";
    }

    const normalizedReason = String(reason);

    if (normalizedReason.startsWith("tcp-error:")) {
      return `the local TCP socket reported ${normalizedReason.replace("tcp-error:", "").trim()}`;
    }

    return reasons[normalizedReason] || normalizedReason;
  }

  formatDeviceForTransportLog(duid) {
    const device = this.getAllHomeDevices().find(
      (entry) => entry && entry.duid === duid
    );
    const name = device?.name || "Roborock vacuum";
    return `${name} (${this.maskIdentifierForLog(duid)})`;
  }

  maskIdentifierForLog(value) {
    if (!value) {
      return "unknown";
    }

    const normalized = String(value);
    if (normalized.length <= 8) {
      return "[redacted]";
    }

    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
  }

  formatLocalIpForLog(value) {
    if (!value) {
      return "";
    }

    const parts = String(value).split(".");
    if (parts.length === 4) {
      return `${parts.slice(0, 3).join(".")}.x`;
    }

    return "local IP present";
  }

  getKnownProducts(homedata) {
    const homeDataSource = homedata || this.getStoredHomeData();
    return this.normalizeArray(homeDataSource?.products || this.products);
  }

  getDeviceAttribute(device, attribute) {
    if (!device) {
      return null;
    }

    const candidateKeys =
      attribute === "model"
        ? ["model", "productModel", "productCode", "modelId"]
        : [attribute];

    for (const key of candidateKeys) {
      const value = device[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }

    return null;
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async startService(callback) {
    this.log.info(`Connecting to your Roborock account…`);
    this.translations = require(
      `./i18n/${this.language || "en"}/translations.json`
    );

    // create new clientID if it doesn't exist yet
    let clientID = "";
    try {
      const storedClientID = await this.getStateAsync("clientID");
      if (storedClientID) {
        clientID = storedClientID.val?.toString() ?? "";
      } else {
        clientID = crypto.randomUUID();
        await this.setStateAsync("clientID", { val: clientID, ack: true });
      }
    } catch (error) {
      this.log.error(
        `Error while retrieving or setting clientID: ${error.message}`
      );
    }

    if (!this.config.username) {
      this.log.error("Email is missing!");
      return;
    }
    if (!this.config.password && !this.isValidUserData(this.userData)) {
      this.log.error("Password or valid token is missing!");
      return;
    }

    this.instance = clientID;

    // Initialize the login API (which is needed to get access to the real API).
    this.loginApi = roborockAuth.createLoginApi({
      baseURL: this.baseURL,
      username: this.config.username,
      clientID,
      language: this.language,
    });
    await this.setStateAsync("info.connection", { val: true, ack: true });
    // api/v1/getUrlByEmail(email = ...)

    // A failed login must NEVER escape as an unhandled rejection: wrong
    // credentials or an unreachable Roborock cloud would otherwise send
    // Homebridge into a crash-restart loop. Credential errors stop here
    // with a clear message; transient/network errors retry with backoff
    // (Homebridge frequently boots before the network is up).
    let userdata;
    try {
      userdata = await this.getUserData(this.loginApi);
    } catch (error) {
      const message = error?.message || String(error);
      await this.setStateAsync("info.connection", { val: false, ack: true });

      const isCredentialError =
        /"code":\s*(2012|2008|2018)/.test(message) ||
        /username or password/i.test(message);
      if (isCredentialError) {
        this.log.error(
          `Roborock login rejected: ${message}. Check the email and password in the plugin settings; the plugin stays idle until the configuration is fixed.`
        );
        this.authState.statusMessage =
          "Login rejected - check email and password.";
        return;
      }

      this._startupLoginAttempts = (this._startupLoginAttempts || 0) + 1;
      if (this._startupLoginAttempts <= 10) {
        const delayMs = Math.min(
          60000 * this._startupLoginAttempts,
          10 * 60000
        );
        this.log.warn(
          `Could not reach the Roborock cloud (attempt ${this._startupLoginAttempts}/10): ${message}. Retrying in ${Math.round(delayMs / 60000)} minute(s).`
        );
        const retryTimer = this.setTimeout(() => {
          this.startService(callback).catch((retryError) => {
            this.log.error(
              `Roborock startup retry failed unexpectedly: ${retryError?.message || retryError}`
            );
          });
        }, delayMs);
        if (typeof retryTimer?.unref === "function") {
          retryTimer.unref();
        }
      } else {
        this.log.error(
          `Could not reach the Roborock cloud after ${this._startupLoginAttempts - 1} attempts: ${message}. Giving up until the next Homebridge restart.`
        );
      }
      return;
    }
    if (!userdata) {
      this.log.error(
        "Login failed or requires 2FA. Please complete authentication in the Config UI."
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
      return;
    }
    this._startupLoginAttempts = 0;

    try {
      this.loginApi.defaults.headers.common["Authorization"] = userdata.token;
    } catch (error) {
      this.log.error(
        "Failed to login. Most likely wrong token! Deleting HomeData and UserData. Try again! " +
          error
      );

      this.deleteStateAsync("HomeData");
      this.deleteStateAsync("UserData");
    }
    const rriot = userdata.rriot;

    // Initialize the real API.
    this.api = axios.create({
      baseURL: rriot.r.a,
    });
    this.api.interceptors.request.use((config) => {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = crypto
          .randomBytes(6)
          .toString("base64")
          .substring(0, 6)
          .replace("+", "X")
          .replace("/", "Y");
        let url;
        if (this.api) {
          url = new URL(this.api.getUri(config));
          const prestr = [
            rriot.u,
            rriot.s,
            nonce,
            timestamp,
            roborockCrypto.md5hex(url.pathname),
            /*queryparams*/ "",
            /*body*/ "",
          ].join(":");
          const mac = crypto
            .createHmac("sha256", rriot.h)
            .update(prestr)
            .digest("base64");

          config.headers["Authorization"] =
            `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
        }
      } catch (error) {
        this.log.error("Failed to initialize API. Error: " + error);
      }
      return config;
    });

    // Get home details.
    try {
      const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
      if (homeDetail) {
        const homeId = homeDetail.data.data.rrHomeId;

        if (this.api) {
          const homedata = await this.api.get(`v2/user/homes/${homeId}`);
          const homedataResult = homedata.data.result;

          // Guard the persisted copy the same way updateHomeData already does.
          // Roborock occasionally answers 200 with an envelope that carries no
          // `result` (maintenance windows, rate limiting). Writing that through
          // stores `{"ack":true}` over the cached device list on disk, so the
          // next restart starts from a destroyed HomeData as well — turning a
          // transient cloud hiccup into a persistent failure.
          if (!homedataResult) {
            throw new Error(
              `The Roborock cloud returned no home data for home ${homeId}. Keeping the previously cached device list.`
            );
          }

          await this.setStateAsync("HomeData", {
            val: JSON.stringify(homedataResult),
            ack: true,
          });

          // Skip devices matching either their serial number or Roborock DUID.
          const ignoredSet = this.getIgnoredDeviceSet();
          // create devices and set states
          this.products = homedataResult.products;
          this.devices = homedataResult.devices || [];
          this.devices = this.devices.filter(
            (device) => !this.shouldSkipDevice(device, ignoredSet)
          );

          const managedDevicesForDiagnostics = this.getManagedHomeDevices(
            homedataResult,
            ignoredSet
          );
          const localKeyDevices = await this.refreshLocalKeysFromHomeData(
            homedataResult,
            ignoredSet
          );

          const cloudOnly = this.isCloudOnlyModeEnabled();
          if (cloudOnly) {
            this.log.info(
              "Roborock cloud-only mode is enabled; local LAN discovery and TCP connections will be skipped."
            );
          }

          for (const device of managedDevicesForDiagnostics) {
            if (cloudOnly) {
              await this.updateTransportDiagnostics(device.duid, {
                lastTransport: "cloud",
                localIp: null,
              });
            } else if (!device.localKey) {
              await this.updateTransportDiagnostics(device.duid, {
                lastTransport: "cloud",
                lastTransportReason: "missing-local-key",
              });
            }

            // Runs in BOTH directions: switching the mode off has to retract
            // the markers it wrote, or they stay on disk for good and the
            // device keeps reporting itself as cloud-only.
            await this.syncCloudOnlyTransportMarkers(device.duid, cloudOnly);
          }

          // this.adapter.log.debug(`initUser test: ${JSON.stringify(Array.from(this.adapter.localKeys.entries()))}`);

          await this.rr_mqtt_connector.initUser(userdata);
          await this.rr_mqtt_connector.initMQTT_Subscribe();
          await this.rr_mqtt_connector.initMQTT_Message();

          // store name of each room via ID
          const rooms = homedataResult.rooms;
          for (const room in rooms) {
            const roomID = rooms[room].id;
            const roomName = rooms[room].name;

            this.roomIDs[roomID] = roomName;
          }
          this.log.debug(`RoomIDs debug: ${JSON.stringify(this.roomIDs)}`);

          // Perform a periodic MQTT health check. Reconnect only if needed.
          this.reconnectIntervall = this.setInterval(async () => {
            this.log.debug(`Running MQTT health check.`);

            await this.rr_mqtt_connector.ensureConnected();
          }, 3600 * 1000);

          this.homedataInterval = this.setInterval(
            this.updateHomeData.bind(this),
            this.updateInterval * 1000,
            homeId
          );

          // LAN discovery listens for UDP broadcasts for a fixed window, so
          // awaiting it here used to stall startup for the full timeout with
          // the CPU idle. Its results are only needed at the merge below, and
          // the local keys it matches against are already loaded, so start it
          // now and let the home-data refresh, device creation and network
          // probes run inside that window instead.
          const localDiscovery = this.isCloudOnlyModeEnabled()
            ? Promise.resolve({})
            : this.localConnector.getLocalDevices().catch((error) => {
                this.log.debug(
                  `LAN discovery failed; continuing with cloud transport: ${error?.message || error}`
                );
                return {};
              });

          await this.updateHomeData(homeId);

          await this.createDevices();

          // Cloud requests fail outright until the MQTT session is up, and
          // the very first ones (the per-robot network probe, then each
          // robot's initial poll) used to be issued a second after the
          // broker handshake started. Wait for the real signal instead of
          // hoping an unrelated delay covers it; a broker that never comes
          // up releases the wait and the requests fail as they would have.
          await this.rr_mqtt_connector.waitUntilConnected();

          // First on the wire once the session is up, because it is the one
          // request an Apple Home tile is waiting for: until a Q7's real
          // status lands, the tile shows the registration snapshot from the
          // Matter store. Started here rather than at the end of
          // createDevices() so the boot poll cannot precede the wait above.
          this.startB01StatusLoop();

          await this.getNetworkInfo();
          await this.initializeDeviceUpdates();

          this.bInited = true;
          this.log.info(
            `Roborock connection ready; ${this.getVacuumList().length} robot(s) available.`
          );

          // LAN attach runs to completion in the background. Everything above
          // works over the cloud, and the transport layer already falls back
          // to it, so holding accessory registration hostage to a fixed-length
          // broadcast listen only delayed the Apple Home tiles.
          void this.attachLocalTransports(localDiscovery, localKeyDevices);
        } else {
          this.log.warn(
            `Roborock returned no home details, so the saved session has been cleared and the plugin will log in from scratch on the next start. If this repeats, re-enter your credentials in the plugin settings.`
          );
          await this.deleteStateAsync(`UserData`);
        }
      }
    } catch (error) {
      // Not an error with a stack: this catch is reached by Roborock
      // maintenance, a rate-limited response and plain DNS failure. The stack
      // tells the user nothing and the line used to end without saying what
      // now happens.
      this.log.warn(
        `Could not fetch your Roborock home details: ${error?.message || error}. This is almost always a temporary Roborock cloud or network problem; no robots will load until the next successful start.`
      );
      this.log.debug(error?.stack || String(error));
    }

    if (callback) {
      callback();
    }
  }

  /**
   * Merge LAN-discovered robots and open their local TCP connections.
   *
   * Deliberately runs after startup has completed: local transport is an
   * optimisation over the cloud path, not a prerequisite for it.
   *
   * @param {Promise<Record<string, string>>} localDiscovery
   * @param {Array<{duid: string}>} localKeyDevices
   */
  async attachLocalTransports(localDiscovery, localKeyDevices) {
    if (this.isCloudOnlyModeEnabled()) {
      return;
    }

    try {
      const discoveredDevices = await localDiscovery;

      // merge udp discovered devices with local devices found via mqtt
      Object.entries(discoveredDevices).forEach(([duid, ip]) => {
        if (!Object.prototype.hasOwnProperty.call(this.localDevices, duid)) {
          this.localDevices[duid] = ip;
        }
      });
      this.log.debug(`localDevices: ${JSON.stringify(this.localDevices)}`);

      for (const device of this.normalizeArray(localKeyDevices)) {
        if (
          !Object.prototype.hasOwnProperty.call(this.localDevices, device.duid)
        ) {
          await this.updateTransportDiagnostics(device.duid, {
            localDiscoveryState: "not-discovered",
            lastTransportReason: "missing-local-ip",
          });
        }
      }

      for (const duid in this.localDevices) {
        const ip = this.localDevices[duid];

        await this.updateTransportDiagnostics(duid, {
          localIp: ip,
          localDiscoveryState: "discovered",
        });
        await this.localConnector.createClient(duid, ip);
      }
    } catch (error) {
      // Local transport is best-effort; the cloud path stays available.
      this.log.debug(
        `Local transport attach failed; continuing on cloud transport: ${error?.message || error}`
      );
    }
  }

  async stopService() {
    try {
      this.flushPendingPersistedStates();
      await this.clearTimersAndIntervals();
      this.bInited = false;
    } catch (e) {
      this.catchError(e.stack);
    }
  }

  /**
   * Schedule a debounced disk flush for a chatty persisted state. The
   * in-memory copy is already current; the trailing flush (unref'd so it
   * never keeps the process alive) writes the LATEST value at most once
   * per PERSIST_FLUSH_DEBOUNCE_MS.
   * @param {string} id
   */
  schedulePersistFlush(id) {
    if (!this._pendingPersistFlushes) {
      this._pendingPersistFlushes = new Map();
    }
    if (this._pendingPersistFlushes.has(id)) {
      return;
    }
    const timer = setTimeout(() => {
      this._pendingPersistFlushes.delete(id);
      this.persistStateToDisk(id);
    }, PERSIST_FLUSH_DEBOUNCE_MS);
    if (typeof timer?.unref === "function") {
      timer.unref();
    }
    this._pendingPersistFlushes.set(id, timer);
  }

  /**
   * Write a persisted state file so only the Homebridge user can read it, and
   * repair the mode on files that already exist. `writeFileSync`'s mode only
   * applies when the file is created, so an install that has been running
   * since before this change would otherwise keep its world-readable
   * UserData/HomeData forever.
   * @param {string} filePath
   * @param {string} contents
   */
  writeSecurePersistFile(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      this.log.debug(
        `Could not tighten permissions on ${filePath}: ${error?.message || error}`
      );
    }
  }

  /** Write the current in-memory value of a persisted state to disk now. */
  persistStateToDisk(id) {
    try {
      const state = this.states[id];
      if (state === undefined) {
        return;
      }
      const persistPath = this.getPersistPath(id);
      this.writeSecurePersistFile(persistPath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.log.debug(
        `Debounced persist of '${id}' failed: ${error?.message || error}`
      );
    }
  }

  /** Flush all pending debounced persists immediately (shutdown path). */
  flushPendingPersistedStates() {
    if (!this._pendingPersistFlushes) {
      return;
    }
    for (const [id, timer] of this._pendingPersistFlushes) {
      clearTimeout(timer);
      this.persistStateToDisk(id);
    }
    this._pendingPersistFlushes.clear();
  }

  async getUserData(loginApi) {
    try {
      if (this.isValidUserData(this.userData)) {
        this.log.info("Using session from config.");
        return this.userData;
      }

      const cachedState = await this.getStateAsync("UserData");
      if (cachedState && cachedState.val) {
        try {
          const cached = JSON.parse(cachedState.val);
          if (this.isValidUserData(cached)) {
            this.userData = cached;
            this.log.info("Using cached session from disk.");
            return cached;
          }
        } catch (error) {
          this.log.warn("Cached session is invalid and will be ignored.");
        }
      }

      if (!this.config.password) {
        this.log.error("Password is missing and no valid token is available.");
        return null;
      }

      const signData = await this.ensureAuthSignature();
      if (!signData) {
        throw new Error("Failed to obtain login signature.");
      }

      const loginResult = await roborockAuth.loginByPassword(loginApi, {
        email: this.config.username,
        password: this.config.password,
        k: signData.k,
        s: signData.s,
      });

      if (loginResult && loginResult.code === 200 && loginResult.data) {
        this.userData = loginResult.data;
        this.pendingAuth = null;
        await this.setStateAsync("UserData", {
          val: JSON.stringify(this.userData),
          ack: true,
        });
        this.authState.twoFactorRequired = false;
        this.authState.statusMessage = "";
        return this.userData;
      }

      if (loginResult && loginResult.code === 2031) {
        this.authState.twoFactorRequired = true;
        this.authState.statusMessage = "Two-factor authentication required.";
        this.log.error(
          "Two-factor authentication required. Use the Config UI to continue."
        );
        return null;
      }

      throw new Error(`Login failed: ${JSON.stringify(loginResult)}`);
    } catch (error) {
      this.log.error(`Error in getUserData: ${error.message}`);
      await this.deleteStateAsync("HomeData");
      await this.deleteStateAsync("UserData");
      throw error;
    }
  }

  isValidUserData(userdata) {
    return userdata && userdata.token && userdata.rriot;
  }

  async ensureAuthSignature() {
    if (this.pendingAuth && this.pendingAuth.k && this.pendingAuth.s) {
      return this.pendingAuth;
    }

    if (!this.loginApi) {
      throw new Error("Login API is not initialized.");
    }

    const s = crypto
      .randomBytes(12)
      .toString("base64")
      .substring(0, 16)
      .replace(/\+/g, "X")
      .replace(/\//g, "Y");
    const signData = await roborockAuth.signRequest(this.loginApi, s);
    if (!signData || !signData.k) {
      return null;
    }

    this.pendingAuth = { k: signData.k, s };
    return this.pendingAuth;
  }

  async sendTwoFactorEmail() {
    if (!this.loginApi) {
      throw new Error("Login API is not initialized.");
    }

    try {
      await roborockAuth.requestEmailCode(this.loginApi, this.config.username);
    } catch (error) {
      this.log.error(`2FA email request failed: ${error.message}`);
      throw error;
    }
    this.authState.twoFactorRequired = true;
    this.authState.statusMessage = "Verification email sent.";
    return { ok: true };
  }

  async verifyTwoFactorCode(code) {
    if (!this.loginApi) {
      throw new Error("Login API is not initialized.");
    }

    const signData = await this.ensureAuthSignature();
    if (!signData) {
      throw new Error("Missing login signature.");
    }

    const region = roborockAuth.getRegionConfig(this.baseURL);
    const loginResult = await roborockAuth.loginWithCode(this.loginApi, {
      email: this.config.username,
      code,
      country: region.country,
      countryCode: region.countryCode,
      k: signData.k,
      s: signData.s,
    });

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      this.userData = loginResult.data;
      this.pendingAuth = null;
      await this.setStateAsync("UserData", {
        val: JSON.stringify(this.userData),
        ack: true,
      });
      this.authState.twoFactorRequired = false;
      this.authState.statusMessage = "Two-factor authentication completed.";
      return this.userData;
    }

    this.log.error(`2FA verification failed: ${JSON.stringify(loginResult)}`);
    throw new Error(
      `2FA verification failed: ${loginResult?.msg || "Unknown error"}`
    );
  }

  async getNetworkInfo() {
    // One round-trip per robot, all independent: probing them in parallel
    // turns N sequential cloud/LAN waits into one at startup. Failures are
    // already handled inside getParameter, but allSettled keeps a rejection
    // from one robot from skipping the others.
    await Promise.allSettled(
      this.devices
        .filter((device) => this.hasInitializedVacuum(device.duid))
        .map((device) =>
          this.vacuums[device.duid].getParameter(
            device.duid,
            "get_network_info"
          )
        )
    );
  }

  async createDevices() {
    const devices = this.devices;
    this.initializedVacuumDuids.clear();

    for (const device of devices) {
      const duid = device.duid;
      const name = device.name;

      this.log.debug(`Creating device: ${name} with duid: ${duid}`);

      // B01/Q7 robots are cloud/MQTT-only: mark them remote up front so the
      // transport layer never attempts local TCP connections to them. The
      // reason travels with the mark so the report says "this protocol has no
      // LAN surface" rather than inventing a LAN connection that failed.
      if (b01Q7Adapter.isB01Protocol(device.pv)) {
        await this.markDeviceRemote(
          duid,
          b01Q7Adapter.B01_CLOUD_ONLY_REMOTE_REASON
        );
      }

      const robotModel = this.getProductAttribute(duid, "model");

      // model must start with "roborock.vacuum."
      if (!this.isSupportedVacuumModel(robotModel)) {
        this.log.warn(
          `Unsupported vacuum model '${robotModel || "unknown"}' for device ${this.describeDevice(duid)}; skipping initialization.`
        );
        continue;
      }

      this.vacuums[duid] = new vacuum_class(this, robotModel);
      this.initializedVacuumDuids.add(duid);
      this.vacuums[duid].name = name;
      this.vacuums[duid].features = new deviceFeatures(
        this,
        device.featureSet,
        device.newFeatureSet,
        duid
      );

      await this.vacuums[duid].features.processSupportedFeatures();

      await this.vacuums[duid].setUpObjects(duid);

      // sub to all commands of this robot
      this.subscribeStates("Devices." + duid + ".commands.*");
      this.subscribeStates("Devices." + duid + ".reset_consumables.*");
      this.subscribeStates("Devices." + duid + ".programs.startProgram");
      this.subscribeStates("Devices." + duid + ".deviceInfo.online");
    }

    // The B01 status loop is deliberately NOT started here. Its device gate
    // reads initializedVacuumDuids, which is only fully populated at this
    // point, so this looked like the earliest safe place — but the loop polls
    // immediately, and a B01 request is cloud-only by construction, and the
    // caller does not wait for the MQTT session until after this method
    // returns. The first status of every single startup was therefore refused
    // with "cloud unavailable". It is started by the caller instead, straight
    // after that wait.
  }

  async initializeDeviceUpdates() {
    this.log.debug(`initializeDeviceUpdates`);

    const devices = this.devices;
    // Each robot's first poll is a chain of round-trips to that robot alone.
    // Running the chains for different robots concurrently keeps a
    // multi-robot startup as fast as a single-robot one; the timers below are
    // still wired up in order, only the initial reads overlap.
    const initialPolls = [];

    for (const device of devices) {
      const duid = device.duid;
      if (!this.hasInitializedVacuum(duid)) {
        continue;
      }

      const robotModel = this.getProductAttribute(duid, "model");

      // The starter functions store the REAL interval handles on the vacuum
      // (self-clearing on restart). Historically the properties held the
      // starter functions themselves, so clearInterval() calls were no-ops
      // and the "restart when missing" check could never fire — one offline
      // flap killed polling forever.
      this.vacuums[duid].mainUpdateInterval = () => {
        this.clearInterval(this.vacuums[duid].mainUpdateIntervalHandle);
        this.vacuums[duid].mainUpdateIntervalHandle = this.setInterval(
          this.updateDataMinimumData.bind(this),
          this.updateInterval * 1000,
          duid,
          this.vacuums[duid],
          robotModel
        );
        return this.vacuums[duid].mainUpdateIntervalHandle;
      };

      if (device.online) {
        this.log.debug(`${duid} online. Starting mainUpdateInterval.`);
        this.vacuums[duid].mainUpdateInterval(); // actually start mainUpdateInterval()
      }

      this.vacuums[duid].getStatusIntervall = () => {
        // B01/Q7 status is owned by the dedicated 15s loop; the per-device
        // tick would only burn cycles hitting the attempt throttle.
        if (
          this.getVacuumDeviceInfo(duid, "pv") ===
          b01Q7Adapter.B01_PROTOCOL_VERSION
        ) {
          return null;
        }
        this.clearInterval(this.vacuums[duid].getStatusIntervalHandle);
        this.vacuums[duid].getStatusIntervalHandle = this.setInterval(
          this.getStatus.bind(this),
          CLASSIC_STATUS_TICK_MS,
          duid,
          this.vacuums[duid],
          robotModel
        );
        return this.vacuums[duid].getStatusIntervalHandle;
      };

      if (device.online) {
        this.log.debug(`${duid} online. Starting getStatusIntervall.`);
        this.vacuums[duid].getStatusIntervall(); // actually start getStatusIntervall()
      }

      initialPolls.push(
        this.updateDataMinimumData(duid, this.vacuums[duid], robotModel)
      );
    }

    await Promise.allSettled(initialPolls);
  }

  async executeScene(sceneID) {
    if (this.api) {
      try {
        await this.api.post(`user/scene/${sceneID.val}/execute`);
      } catch (error) {
        this.catchError(error.stack, "executeScene");
      }
    }
  }

  getProductAttribute(duid, attribute) {
    const device = this.getVacuumDeviceData(duid);
    const deviceValue = this.getDeviceAttribute(device, attribute);
    if (deviceValue !== null) {
      return deviceValue;
    }

    const products = this.getKnownProducts();
    const productID = device?.productId;
    const product = products.find((entry) => entry.id == productID);

    if (!product) {
      return null;
    }

    const productValue = this.getDeviceAttribute(product, attribute);
    return productValue !== null ? productValue : null;
  }

  getVacuumSchemaCodes(duid) {
    const productId = this.getVacuumDeviceInfo(duid, "productId");
    const product = this.getProductData(productId);
    return this.normalizeArray(product?.schema)
      .map((schema) => schema?.code)
      .filter((code) => typeof code == "string" && code.trim());
  }

  hasVacuumSchemaCode(duid, codes) {
    const requestedCodes = Array.isArray(codes) ? codes : [codes];
    const schemaCodes = new Set(this.getVacuumSchemaCodes(duid));
    return requestedCodes.some((code) => schemaCodes.has(code));
  }

  hasVacuumFeature(duid, features) {
    const requestedFeatures = Array.isArray(features) ? features : [features];
    const featureList = this.vacuums[duid]?.features?.getFeatureList?.();
    if (!featureList) {
      return false;
    }

    return requestedFeatures.some((feature) => Boolean(featureList[feature]));
  }

  getMatterCleanModeCapabilities(duid) {
    // Q7-series (B01) robots use a manually filled water tank on the robot
    // with no electronic mop/water control, so Matter must never expose mop
    // modes for them regardless of what the generic cloud schema claims.
    // Suction (Q7 "wind") is controllable via the B01 adapter.
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      return {
        // Q7 robots mop with a manually filled tank: expose the mop/vacuum
        // mode switch, but never water-level status or control.
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        // The B01 wire protocol defines five wind levels; level 5 is the
        // Max+ boost (v1 fan power 108 via the adapter translation).
        canMaxPlusFanPower: true,
        canControlWater: false,
      };
    }

    const canControlFanPower =
      this.hasVacuumSchemaCode(duid, "fan_power") ||
      this.getVacuumDeviceStatus(duid, "fan_power") !== "";
    const hasWaterModeSchema = this.hasVacuumSchemaCode(duid, [
      "water_box_mode",
      "water_box_custom_mode",
    ]);
    const hasMopSchema = this.hasVacuumSchemaCode(duid, [
      "mop_mode",
      "mop_forbidden_enable",
    ]);
    const hasMopFeature = this.hasVacuumFeature(duid, [
      "isSupportedWaterMode",
      "isShakeMopSetSupported",
      "isElectronicWaterBoxSupported",
      "isCleanRouteFastModeSupported",
      "isMopForbiddenSupported",
      "isShakeMopStrengthSupported",
      "isWaterBoxSupported",
    ]);

    return {
      canVacuum: true,
      canMop: hasWaterModeSchema || hasMopSchema || hasMopFeature,
      canControlFanPower,
      // Max+ (fan power 108) only where the upstream-vetted per-model
      // feature data confirms the level (e.g. S8 Pro Ultra) — field
      // reports with diagnostics exports extend the list.
      canMaxPlusFanPower: supportsMaxPlusFanPower(
        this.getProductAttribute(duid, "model")
      ),
      canControlWater:
        hasWaterModeSchema ||
        this.hasVacuumFeature(duid, [
          "isSupportedWaterMode",
          "isShakeMopSetSupported",
          "isElectronicWaterBoxSupported",
          "isShakeMopStrengthSupported",
        ]),
    };
  }

  buildCommandOptions(options, extraDefaults = {}) {
    const waitForResult = Boolean(options.waitForResult);
    const commandOptions = waitForResult
      ? { ...extraDefaults, ...options, throwOnError: true }
      : { ...extraDefaults, ...options };

    return { waitForResult, commandOptions };
  }

  /**
   * The caller races this whole sequence against a single window and sends the
   * start command the moment it closes, so a command that is merely *started*
   * inside the window buys nothing. Each command therefore gets whatever is
   * left of the window rather than a fixed per-command timeout.
   *
   * @param {number | undefined} prepWindowMs The caller's window, if it has one.
   * @returns {{ timeoutFor: () => number | null }} `timeoutFor` returns the
   *   timeout to give the next command, or `null` when there is no time left —
   *   in which case the command must be skipped and reported, never sent. A
   *   non-positive `requestTimeoutMs` is not an override to messageQueueHandler:
   *   it silently restores that layer's own ten-second default, which is four
   *   times the whole window.
   */
  createMatterCleanModePrepBudget(prepWindowMs) {
    const windowMs = Number(prepWindowMs);
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      return { timeoutFor: () => MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS };
    }

    const deadline = Date.now() + windowMs - MATTER_CLEAN_MODE_PREP_MARGIN_MS;

    return {
      timeoutFor: () => {
        const remaining = deadline - Date.now();
        return remaining > 0
          ? Math.min(MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS, remaining)
          : null;
      },
    };
  }

  /**
   * Every way the prep can end without the robot having confirmed the mode the
   * user picked reports through here, at warn.
   *
   * At warn level on purpose. The clean is about to start and the Matter tile
   * will report the mode the user selected, so a silent partial apply leaves
   * the tile stating something the robot is not doing. That mismatch is exactly
   * what took two rounds of #8 to pin down, and the log is where the next
   * person will look. Reaching it from one place is what stops a new exit path
   * from being silent by omission — the "no water command detected" branch was
   * debug-only, and that is precisely the case where the mop ran anyway.
   *
   * It also returns what it reported, because the caller has to act on it and
   * previously could not: this method resolves normally on a partial apply, so
   * "sent and acknowledged" and "sent, unconfirmed, robot may keep its previous
   * settings" arrived at the caller as the same `undefined`. Measured in #8
   * (skmzwanke, Saros 10, 18 Aug 2026): the water mode went unconfirmed, the
   * robot kept mopping, and Apple Home was pinned to the Vacuum he had asked
   * for — so the plugin hid the very failure this warning announces.
   *
   * `cleanTypeConfirmed` answers only the question the caller needs to ask, and
   * an unconfirmed suction level does not disturb it: it is a level inside the
   * type, not the type.
   *
   * @param {string} duid
   * @param {string[]} unconfirmedSettings
   * @returns {{ unconfirmedSettings: string[], cleanTypeConfirmed: boolean }}
   */
  reportUnconfirmedMatterCleanModeSettings(duid, unconfirmedSettings) {
    const reported = [...new Set(unconfirmedSettings)];
    const result = {
      unconfirmedSettings: reported,
      cleanTypeConfirmed: !reported.some((label) =>
        MATTER_CLEAN_TYPE_PREP_LABELS.has(label)
      ),
    };

    if (reported.length === 0) {
      return result;
    }

    this.log.warn(
      `Roborock did not confirm the ${reported.join(" and ")} for ${this.describeDevice(duid)} before starting; the robot may keep its previous settings for this run, so the clean may not match the mode selected in your controller.`
    );

    return result;
  }

  /**
   * Make the robot match the clean mode the controller is displaying, before a
   * Matter-initiated start.
   *
   * Resolves rather than rejecting on a partial apply — the start command is
   * sent either way — so the resolved value is the only place the caller can
   * learn whether the user's clean TYPE actually landed.
   *
   * @param {string} duid
   * @param {{ cleanMode?: number, fanPower?: number, waterBoxMode?: number }} settings
   * @param {Record<string, unknown>} [options]
   * @returns {Promise<{ unconfirmedSettings: string[], cleanTypeConfirmed: boolean }>}
   */
  async applyMatterCleanModeSettings(duid, settings, options = {}) {
    const { prepWindowMs, ...commandInput } = options ?? {};
    const budget = this.createMatterCleanModePrepBudget(prepWindowMs);
    const { commandOptions } = this.buildCommandOptions(commandInput, {
      requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
    });
    const unconfirmedSettings = [];

    // Returns null when the window has closed. The caller must then skip the
    // command: sending it would hand the transport a timeout nobody is waiting
    // for, which is the shape of the original defect.
    const takeCommandOptions = (label) => {
      const requestTimeoutMs = budget.timeoutFor();
      if (requestTimeoutMs === null) {
        unconfirmedSettings.push(label);
        this.log.debug(
          `Matter clean mode ${label} for ${duid} was not sent: the prep window closed before its turn.`
        );
        return null;
      }

      return { ...commandOptions, requestTimeoutMs };
    };

    // Q7/B01: the robot has a native clean-type concept (vacuum / mop /
    // vacuum+mop via the `mode` property), so apply the Matter selection
    // directly. The v1-style workarounds (fan power OFF to fake mop-only,
    // water box modes) do not apply — Q7 water is a manual tank.
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      // These used to go through startCommand(), whose SIMPLE_VACUUM_COMMANDS
      // allow-list contains neither `set_clean_type` nor `set_custom_mode` —
      // so both fell through to `Command ... not found.` and nothing was ever
      // sent to the robot. Mathias' own Homebridge log has carried that line
      // since 2026-07-13. runMatterSettingCommand is the same path the classic
      // (non-B01) branch below already uses: it goes straight to
      // vacuum.command and reports unsupported results as errors.
      //
      // The value stays wrapped in an array on purpose. Matter clean mode 0 is
      // a valid selection (vacuum), and vacuum.command's default branch tests
      // `if (value && ...)` — a bare 0 is falsy and would silently be sent as
      // an empty parameter list, which b01Q7Adapter then drops entirely.
      // The clean type carries the user's choice on this dialect, so it goes
      // first and gets the window before the suction level, which is only a
      // level inside the chosen type.
      if (Number.isInteger(settings?.cleanMode)) {
        const cleanTypeOptions = takeCommandOptions("clean type");
        if (cleanTypeOptions) {
          try {
            await this.runMatterSettingCommand(
              duid,
              "set_clean_type",
              [settings.cleanMode],
              cleanTypeOptions
            );
          } catch (error) {
            this.rememberUnsupportedMatterSettingCommand(
              duid,
              "set_clean_type",
              error
            );
            unconfirmedSettings.push("clean type");
            this.log.debug(
              `B01 clean-type command failed for ${duid}; continuing with the start command. ${error.message || error}`
            );
          }
        }
      }

      const fanPower = settings?.fanPower;
      if (Number.isInteger(fanPower) && fanPower !== 105) {
        const fanOptions = takeCommandOptions("suction level");
        if (fanOptions) {
          try {
            await this.runMatterSettingCommand(
              duid,
              "set_custom_mode",
              [fanPower],
              fanOptions
            );
          } catch (error) {
            this.rememberUnsupportedMatterSettingCommand(
              duid,
              "set_custom_mode",
              error
            );
            unconfirmedSettings.push("suction level");
            this.log.debug(
              `B01 suction command failed for ${duid}; continuing with the start command. ${error.message || error}`
            );
          }
        }
      }

      return this.reportUnconfirmedMatterCleanModeSettings(
        duid,
        unconfirmedSettings
      );
    }

    // The water command goes first, and no failure below cancels a later
    // command.
    //
    // On a v1 robot the difference between "Vacuum" and "Vacuum and mop" IS
    // the water-box mode: selecting Vacuum sends water-box OFF. Fan power is a
    // suction level *within* the chosen mode. The fan command used to run
    // first and, on timeout, return — skipping the water command entirely. So
    // skmzwanke selected Vacuum in Apple Home, the fan command timed out after
    // two seconds, the water command was never sent, and his Saros 10 ran a
    // vacuum-and-mop over the room he had asked to be vacuumed (#8). A
    // cosmetic command that did not answer in time cancelled the one that
    // carried the user's actual choice.
    //
    // Dropping the early return cannot run the start command late: the caller
    // races this whole sequence against its own prep timeout, which is what
    // bounds the delay. The early return was buying latency protection that
    // was already paid for one level up.
    //
    // Ordering alone was not enough, though, and skmzwanke's 3.4.8 log shows
    // why: up to three commands are sent one after another, each with a
    // two-second timeout, inside a window of 2500 ms. The water command was
    // started but not finished when the window closed, so the start command
    // still overtook the command carrying his "vacuum only" choice and the
    // robot mopped. Sizing each command against what is LEFT of the window is
    // what makes the order matter — the mode-carrying command now gets the
    // window, and a cosmetic one that no longer fits is reported, not started.
    if (Number.isInteger(settings?.waterBoxMode)) {
      const waterCommands = this.getMatterWaterModeCommandCandidates(duid);

      if (waterCommands.length === 0) {
        // Reached only when the plugin believes water is controllable — i.e.
        // Apple Home is offering mop modes — but has no command left to send.
        // That is the user's clean mode silently not happening, so it reports.
        unconfirmedSettings.push("water mode");
        this.log.debug(
          `Matter clean mode requested water mode ${settings.waterBoxMode} for ${duid}, but no supported Roborock water command was detected.`
        );
      } else {
        const waterOptions = takeCommandOptions("water mode");
        if (waterOptions) {
          try {
            await this.runFirstMatterSettingCommand(
              duid,
              waterCommands,
              settings.waterBoxMode,
              waterOptions,
              budget
            );
          } catch (error) {
            unconfirmedSettings.push("water mode");
            this.log.debug(
              `Matter clean mode water commands failed for ${duid}; continuing with start command. ${error.message || error}`
            );
          }
        }
      }
    }

    if (
      Number.isInteger(settings?.fanPower) &&
      this.getMatterCleanModeCapabilities(duid).canControlFanPower
    ) {
      const fanOptions = takeCommandOptions("suction level");
      if (fanOptions) {
        try {
          await this.runMatterSettingCommand(
            duid,
            "set_custom_mode",
            settings.fanPower,
            fanOptions
          );
        } catch (error) {
          this.rememberUnsupportedMatterSettingCommand(
            duid,
            "set_custom_mode",
            error
          );
          unconfirmedSettings.push("suction level");
          this.log.debug(
            `Matter clean mode fan command failed for ${duid}; continuing with start command. ${error.message || error}`
          );
        }
      }
    }

    return this.reportUnconfirmedMatterCleanModeSettings(
      duid,
      unconfirmedSettings
    );
  }

  getMatterWaterModeCommandCandidates(duid) {
    const commands = [];

    if (this.hasVacuumSchemaCode(duid, "water_box_mode")) {
      commands.push("set_water_box_mode");
      commands.push("set_water_box_custom_mode");
    }

    if (
      this.hasVacuumSchemaCode(duid, "water_box_custom_mode") ||
      this.hasVacuumFeature(duid, [
        "isSupportedWaterMode",
        "isShakeMopSetSupported",
        "isElectronicWaterBoxSupported",
        "isShakeMopStrengthSupported",
      ])
    ) {
      commands.push("set_water_box_custom_mode");
    }

    if (
      commands.length === 0 &&
      this.getMatterCleanModeCapabilities(duid).canControlWater
    ) {
      commands.push("set_water_box_custom_mode");
    }

    return [...new Set(commands)].filter(
      (command) =>
        !this.matterUnsupportedSettingCommands.has(
          this.getMatterSettingCommandKey(duid, command)
        )
    );
  }

  async runFirstMatterSettingCommand(
    duid,
    commands,
    value,
    options = {},
    budget = null
  ) {
    let lastError = null;

    for (const [attempt, command] of commands.entries()) {
      // Each fallback costs another timeout out of the same window, so it is
      // re-sized here too. The first attempt keeps the timeout the caller
      // already budgeted for it.
      let attemptOptions = options;
      if (budget && attempt > 0) {
        const requestTimeoutMs = budget.timeoutFor();
        if (requestTimeoutMs === null) {
          this.log.debug(
            `Matter clean mode command ${command} was not tried for ${duid}: the prep window closed before the fallback's turn.`
          );
          break;
        }
        attemptOptions = { ...options, requestTimeoutMs };
      }

      try {
        await this.runMatterSettingCommand(
          duid,
          command,
          value,
          attemptOptions
        );
        return;
      } catch (error) {
        lastError = error;
        const canTryFallback =
          this.shouldRememberUnsupportedMatterCommand(error);
        if (canTryFallback) {
          this.rememberUnsupportedMatterSettingCommand(duid, command, error);
          this.log.debug(
            `Matter clean mode command ${command} failed for ${duid}; trying another water command if available. ${error.message || error}`
          );
          continue;
        }

        this.log.debug(
          `Matter clean mode command ${command} failed for ${duid}; not trying fallback commands before start. ${error.message || error}`
        );
        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  async runMatterSettingCommand(duid, command, value, options = {}) {
    if (!this.isInited()) {
      this.log.warn(
        `Command for ${this.describeDevice(duid)} was dropped because the Roborock connection has not finished starting up. Try again in a few seconds.`
      );
      return;
    }

    const vacuum = this.vacuums[duid];
    if (!vacuum || typeof vacuum.command != "function") {
      throw new Error(
        `Vacuum ${this.describeDevice(duid)} is not initialized.`
      );
    }

    const result = await vacuum.command(duid, command, value, options);
    if (this.shouldRememberUnsupportedMatterCommand(result)) {
      throw new Error(
        `${command} returned unsupported result: ${JSON.stringify(result)}`
      );
    }
    return result;
  }

  getMatterSettingCommandKey(duid, command) {
    return `${duid}:${command}`;
  }

  rememberUnsupportedMatterSettingCommand(duid, command, error) {
    if (this.shouldRememberUnsupportedMatterCommand(error)) {
      this.matterUnsupportedSettingCommands.add(
        this.getMatterSettingCommandKey(duid, command)
      );
    }
  }

  shouldRememberUnsupportedMatterCommand(error) {
    const message = `${error?.message || error || ""}`.toLowerCase();
    return [
      "unsupported",
      "not supported",
      "unknown method",
      "unknown_method",
      "method not found",
      "invalid method",
      "unknown parameter",
    ].some((pattern) => message.includes(pattern));
  }

  /**
   * Self-healing capability detection for periodic poll commands: once a
   * robot definitively answers a request with an "unsupported"-class error,
   * the command is skipped for that device until the next restart (firmware
   * updates get a fresh probe). Timeouts and transport errors never count.
   * @param {string} duid @param {string} parameter
   */
  isPollCommandUnsupported(duid, parameter) {
    return this.unsupportedPollCommands.has(`${duid}:${parameter}`);
  }

  /**
   * @param {string} duid @param {string} parameter @param {unknown} error
   * @returns {boolean} true when the error was an unsupported-class answer
   * and has been remembered (the caller can stop treating it as a failure).
   */
  rememberUnsupportedPollCommand(duid, parameter, error) {
    if (!this.shouldRememberUnsupportedMatterCommand(error)) {
      return false;
    }
    const key = `${duid}:${parameter}`;
    if (!this.unsupportedPollCommands.has(key)) {
      this.unsupportedPollCommands.add(key);
      // `|| duid` used to put a raw 22-character id in front of the user
      // whenever the product lookup missed, and laundering it through a local
      // variable hid that from the log-naming rule.
      const model = this.getProductAttribute(duid, "model") || "unknown model";
      this.log.debug(
        `${this.describeDevice(duid)} (${model}) answered '${parameter}' with an unsupported-method error; that request is skipped for this robot until the next restart.`
      );
    }
    return true;
  }

  /**
   * Poll one v1 parameter, unless the robot speaks a dialect that has no
   * answer for it. Every periodic probe goes through here so the rule holds
   * for probes added later, not just the three that were reported.
   * @param {string} duid @param {any} vacuum @param {string} method
   * @param {boolean} isB01
   * @returns {Promise<any>}
   */
  async pollParameter(duid, vacuum, method, isB01) {
    if (isB01 && !b01Q7Adapter.canAnswerV1Method(method)) {
      const key = `${duid}:${method}`;
      if (!this.skippedDialectPolls.has(key)) {
        this.skippedDialectPolls.add(key);
        this.log.debug(
          `Not polling '${method}' for ${this.describeDevice(duid)}: the Q7/B01 dialect has no equivalent request, so the robot could only ever reject it.`
        );
      }
      return undefined;
    }

    return vacuum.getParameter(duid, method);
  }

  startMainUpdateInterval(duid, online) {
    if (!this.hasInitializedVacuum(duid)) {
      return;
    }

    const robotModel = this.getProductAttribute(duid, "model");

    this.vacuums[duid].mainUpdateInterval = () => {
      this.clearInterval(this.vacuums[duid].mainUpdateIntervalHandle);
      this.vacuums[duid].mainUpdateIntervalHandle = this.setInterval(
        this.updateDataMinimumData.bind(this),
        this.updateInterval * 1000,
        duid,
        this.vacuums[duid],
        robotModel
      );
      return this.vacuums[duid].mainUpdateIntervalHandle;
    };
    if (online) {
      this.log.debug(`${duid} online. Starting mainUpdateInterval.`);
      this.vacuums[duid].mainUpdateInterval(); // actually start mainUpdateInterval()
      // Map updater gets startet automatically via getParameter with get_status
    }
  }

  async onlineChecker(duid) {
    const homedataJSON = this.getStoredHomeData();

    // If the home data is not found or if its value is not a string, return false.
    if (homedataJSON) {
      const device = homedataJSON.devices.find((device) => device.duid == duid);
      const receivedDevice = homedataJSON.receivedDevices.find(
        (device) => device.duid == duid
      );

      // If the device is not found, return false.
      if (!device && !receivedDevice) {
        return false;
      }

      const onlineState = device?.online || receivedDevice?.online;
      await this.updateTransportDiagnostics(duid, {
        online: Boolean(onlineState),
      });
      return onlineState;
    } else {
      await this.updateTransportDiagnostics(duid, {
        online: false,
      });
      return false;
    }
  }

  /**
   * Marks a vacuum as reachable only over the Roborock cloud, recording WHY.
   *
   * Membership of `remoteDevices` cannot answer "why" on its own, and the two
   * reasons are not remotely alike. A B01/Q7 robot is marked at startup
   * because its dialect has no LAN request surface, so no local connection is
   * ever attempted; another robot is marked only after a local TCP connect
   * genuinely failed. The report used to state the second reason for both,
   * which sent a Q7 owner through an unpair, a plugin uninstall, a reinstall
   * and a fresh pairing chasing a LAN fault that could not exist (#7).
   *
   * Every caller therefore supplies its own reason. A caller that forgets one
   * degrades to the vague `remote-device`, which is merely uninformative —
   * never to a specific claim that is false.
   *
   * @param {string} duid
   * @param {string} reason
   */
  async markDeviceRemote(duid, reason) {
    if (!duid) {
      return;
    }

    const remoteReason = reason || UNEXPLAINED_REMOTE_REASON;
    this.remoteDevices.add(duid);
    this.remoteDeviceReasons.set(duid, remoteReason);

    await this.updateTransportDiagnostics(duid, {
      isRemote: true,
      remoteReason,
    });
  }

  /**
   * A local reply arrived, so the socket is not mute. Called from the one place
   * a local response lands, so the count measures the socket's current silence
   * rather than its history.
   *
   * @param {string} duid
   * @returns {void}
   */
  noteLocalRequestSucceeded(duid) {
    if (!duid) {
      return;
    }

    this.localMuteTimeouts.delete(duid);
  }

  /**
   * A local request timed out on a socket that reported itself connected. After
   * LOCAL_MUTE_TIMEOUT_LIMIT of those in a row the LAN is written off for this
   * robot and the cloud is used instead, because the alternative is paying the
   * full timeout on every poll and every command for the life of the process.
   *
   * @param {string} duid
   * @param {string} [method] the request that died, for the log line
   * @returns {Promise<void>}
   */
  async noteLocalRequestTimedOut(duid, method) {
    if (!duid) {
      return;
    }

    const failures = (this.localMuteTimeouts.get(duid) || 0) + 1;
    this.localMuteTimeouts.set(duid, failures);

    if (failures < LOCAL_MUTE_TIMEOUT_LIMIT) {
      return;
    }

    // Already written off: say it once, then stay quiet. The timeouts keep
    // coming until something upstream changes, and a warning per poll would
    // bury the one line that explains the switch.
    if (this.remoteDevices.has(duid)) {
      return;
    }

    this.log.warn(
      `The local connection to ${this.describeDevice(duid)} connected but answered nothing: ` +
        `${failures} requests in a row timed out${method ? ` (last: ${method})` : ""}. ` +
        `Using the Roborock cloud for this robot instead. The LAN port is reachable, ` +
        `so this is not a blocked port — the robot is not replying on it. On a segmented ` +
        `network, check that the reply path back to Homebridge is open, not just the ` +
        `outbound one.`
    );

    await this.markDeviceRemote(duid, LOCAL_MUTE_REMOTE_REASON);
  }

  /**
   * Drops the remote marker and the reason that went with it.
   *
   * @param {string} duid
   * @returns {boolean} whether the vacuum had been marked remote
   */
  clearRemoteDevice(duid) {
    this.remoteDeviceReasons.delete(duid);
    return this.remoteDevices.delete(duid);
  }

  /**
   * @param {string} duid
   * @returns {string} the recorded reason, or the vague default
   */
  getRemoteDeviceReason(duid) {
    return this.remoteDeviceReasons.get(duid) || UNEXPLAINED_REMOTE_REASON;
  }

  async isRemoteDevice(duid) {
    const homedataJSON = this.getStoredHomeData();

    if (homedataJSON) {
      const receivedDevice = homedataJSON.receivedDevices.find(
        (device) => device.duid == duid
      );
      const remoteDevice = this.remoteDevices.has(duid);

      if (receivedDevice || remoteDevice) {
        await this.updateTransportDiagnostics(duid, {
          isRemote: true,
          remoteReason: receivedDevice
            ? "received-device"
            : this.getRemoteDeviceReason(duid),
        });
        return true;
      }

      await this.updateTransportDiagnostics(duid, {
        isRemote: false,
        remoteReason: null,
      });
      return false;
    } else {
      await this.updateTransportDiagnostics(duid, {
        isRemote: false,
      });
      return false;
    }
  }

  async manageDeviceIntervals(duid) {
    if (!this.hasInitializedVacuum(duid)) {
      return false;
    }

    return this.onlineChecker(duid)
      .then((onlineState) => {
        const vacuum = this.vacuums[duid];
        if (!onlineState && vacuum.mainUpdateIntervalHandle) {
          this.clearInterval(vacuum.getStatusIntervalHandle);
          this.clearInterval(vacuum.mainUpdateIntervalHandle);
          vacuum.getStatusIntervalHandle = null;
          vacuum.mainUpdateIntervalHandle = null;
        } else if (onlineState && !vacuum.mainUpdateIntervalHandle) {
          vacuum.getStatusIntervall();
          this.startMainUpdateInterval(duid, onlineState);
        }
        return onlineState;
      })
      .catch((error) => {
        this.log.error("startStopIntervals " + error);

        return false; // Make device appear as offline on error. Just in case.
      });
  }

  isSupportedVacuumModel(model) {
    return typeof model === "string" && model.startsWith("roborock.vacuum.");
  }

  hasInitializedVacuum(duid) {
    return this.initializedVacuumDuids.has(duid) && !!this.vacuums[duid];
  }

  async updateDataMinimumData(duid, vacuum, robotModel) {
    this.log.debug(`Latest data requested`);

    if (this.isSupportedVacuumModel(robotModel)) {
      // Q7-series robots speak the B01 dialect, where a good half of the v1
      // poll chain has no equivalent request at all. Asking anyway produced
      // an "unsupported" notice per robot per restart for a request the
      // plugin itself rejected before it ever reached the robot.
      const isB01 = b01Q7Adapter.isB01Protocol(
        await this.getRobotVersion(duid)
      );

      const refreshedServiceAreaRooms =
        await this.refreshMatterServiceAreaRoomMappings(duid, vacuum);

      if (!refreshedServiceAreaRooms) {
        await this.pollParameter(duid, vacuum, "get_room_mapping", isB01);
      }

      await this.pollParameter(duid, vacuum, "get_consumable", isB01);

      await this.pollParameter(duid, vacuum, "get_server_timer", isB01);

      await this.pollParameter(duid, vacuum, "get_timer", isB01);

      await this.checkForNewFirmware(duid);

      switch (robotModel) {
        case "roborock.vacuum.s4":
        case "roborock.vacuum.s5":
        case "roborock.vacuum.s5e":
        case "roborock.vacuum.a08":
        case "roborock.vacuum.a10":
        case "roborock.vacuum.a40":
        case "roborock.vacuum.a140":
        case "roborock.vacuum.a95":
        case "roborock.vacuum.a159":
        case "roborock.vacuum.ss07":
          //do nothing
          break;
        case "roborock.vacuum.s6":
          await this.pollParameter(duid, vacuum, "get_carpet_mode", isB01);
          break;
        case "roborock.vacuum.a27":
          await this.pollParameter(
            duid,
            vacuum,
            "get_dust_collection_switch_status",
            isB01
          );
          await this.pollParameter(duid, vacuum, "get_wash_towel_mode", isB01);
          await this.pollParameter(
            duid,
            vacuum,
            "get_smart_wash_params",
            isB01
          );
          await this.pollParameter(
            duid,
            vacuum,
            "app_get_dryer_setting",
            isB01
          );
          break;
        default: {
          // No dedicated poll profile for this model: derive it from the
          // robot's own capability bitmask when available instead of blindly
          // probing, and say so once — clearer than silent guessing for
          // newly released models (Saros 10, Q5 Max+, QX Revo Plus, ...).
          const featureList =
            this.vacuums[duid]?.features?.getFeatureList?.() || null;
          const carpetSupported = featureList
            ? Boolean(featureList.isCarpetSupported)
            : true;
          const waterBoxProbe =
            !isB01 ||
            b01Q7Adapter.canAnswerV1Method("get_water_box_custom_mode");
          // Keyed on the rendered line, not on the duid. Every value in it
          // is derived from the model, so a duid key printed the identical
          // sentence once per robot — and the sentence names no robot, so a
          // three-robot household could not tell which two it was about.
          // The key is the model-derived sentence ONLY. 3.6.0 keyed on the
          // whole rendered line and then appended the robot's name to it,
          // which made the key per-robot again and printed the duplicate it
          // was meant to remove. The robot name is added after the key is
          // taken, not before.
          const profileKey = `No dedicated poll profile for model '${robotModel}'; using ${featureList ? "capability-derived" : "generic"} polls (carpet=${carpetSupported ? "yes" : "no"}, water-box probe=${waterBoxProbe ? "yes" : "no, the Q7/B01 dialect has no such request"}). Requests the robot reports as unsupported are disabled automatically.`;
          if (!this.loggedPollProfiles.has(profileKey)) {
            this.loggedPollProfiles.add(profileKey);
            this.log.info(
              `${profileKey} First seen on ${this.describeDevice(duid)}. If states look wrong for this model, please open a model report issue on GitHub.`
            );
          }
          if (carpetSupported) {
            await this.pollParameter(duid, vacuum, "get_carpet_mode", isB01);
            await this.pollParameter(
              duid,
              vacuum,
              "get_carpet_clean_mode",
              isB01
            );
          }
          await this.pollParameter(
            duid,
            vacuum,
            "get_water_box_custom_mode",
            isB01
          );
        }
      }
    } else {
      this.log.warn(
        `Model lookup mismatch for ${this.describeDevice(duid)}: HomeData reports '${robotModel || "unknown"}', which does not look like a Roborock vacuum model string. Skipping the periodic data update for this device. If this is a real vacuum, please open a model report issue on GitHub with a diagnostics export from the plugin settings.`
      );
    }
  }

  async refreshMatterServiceAreaRoomMappings(duid, vacuum) {
    if (
      !this.config.enableMatterServiceArea &&
      !this.config.enableMatterServiceAreaBeta
    ) {
      return false;
    }

    // Room/map data on B01 (Q7-series) robots travels over the protobuf map
    // channel instead of the classic get_room_mapping flow.
    const robotVersion = await this.getRobotVersion(duid);
    if (b01Q7Adapter.isB01Protocol(robotVersion)) {
      // With a persisted room cache, Service Area can expose rooms
      // immediately; run the refresh in the background so a slow map channel
      // never delays startup or the caller.
      if (this.getB01RoomCache(duid).length > 0) {
        void this.refreshB01Rooms(duid).catch((error) => {
          this.log.debug(
            `Background B01 room refresh failed for ${duid}: ${error.message || error}`
          );
        });
        return true;
      }

      try {
        await this.refreshB01Rooms(duid);
        return true;
      } catch (error) {
        this.log.debug(
          `B01 room refresh failed for ${duid}: ${error.message || error}`
        );
        return false;
      }
    }

    try {
      await vacuum.getParameter(duid, "get_multi_maps_list");
      await vacuum.getParameter(duid, "get_room_mapping");
      await this.cacheMissingMatterServiceAreaRoomMappings(duid, vacuum);
      return true;
    } catch (error) {
      this.log.debug(
        `Failed to refresh Matter Service Area room mappings for ${duid}: ${error.message || error}`
      );
      return false;
    }
  }

  async cacheMissingMatterServiceAreaRoomMappings(duid, vacuum) {
    const maps = this.getMapListForDevice(duid);
    if (maps.length < 2) {
      return;
    }

    const missingMaps = maps.filter(
      (map) =>
        this.getRoomMappingsForMap(duid, map.mapId).length === 0 &&
        this.shouldAttemptServiceAreaRoomMapRefresh(duid, map.mapId)
    );
    if (missingMaps.length === 0) {
      return;
    }

    const state = this.getCachedVacuumState(duid);
    if (this.isCleaning(state)) {
      this.log.debug(
        `Skipping Matter Service Area room-map refresh for ${duid}; robot is busy.`
      );
      return;
    }

    const originalMapId = this.getCurrentMapIdForDevice(duid);

    try {
      for (const map of missingMaps) {
        this.markServiceAreaRoomMapRefreshAttempt(duid, map.mapId);

        try {
          if (map.mapId === originalMapId) {
            await vacuum.getParameter(duid, "get_room_mapping");
          } else {
            this.log.info(
              `Loading Roborock map '${map.name}' for ${this.describeDevice(duid)} to cache Matter Service Area rooms.`
            );
            await vacuum.command(duid, "load_multi_map", map.mapId, {
              throwOnError: true,
            });
          }
        } catch (error) {
          // A single slow/failed map switch must not abort the remaining maps
          // or skip restoring the original map below.
          this.log.debug(
            `Failed to load Roborock map '${map.name}' for ${duid} while caching Matter Service Area rooms: ${error.message || error}`
          );
          continue;
        }

        if (this.getRoomMappingsForMap(duid, map.mapId).length === 0) {
          this.log.info(
            `Roborock map '${map.name}' for ${this.describeDevice(duid)} did not return room mappings. It will appear in Matter once Roborock reports room segment IDs for that saved map.`
          );
        }
      }
    } finally {
      // Always try to put the robot back on the map it started on, even if a
      // load above timed out, so the refresh never leaves it on another map.
      await this.restoreServiceAreaOriginalMap(
        duid,
        vacuum,
        maps,
        originalMapId
      );
    }
  }

  shouldAttemptServiceAreaRoomMapRefresh(duid, mapId) {
    const key = this.getServiceAreaRoomMapRefreshKey(duid, mapId);
    const lastAttempt = this.serviceAreaRoomMapRefreshAttempts.get(key);

    return (
      lastAttempt === undefined ||
      this.now() - lastAttempt >= SERVICE_AREA_ROOM_MAP_REFRESH_TTL_MS
    );
  }

  markServiceAreaRoomMapRefreshAttempt(duid, mapId) {
    this.serviceAreaRoomMapRefreshAttempts.set(
      this.getServiceAreaRoomMapRefreshKey(duid, mapId),
      this.now()
    );
  }

  async restoreServiceAreaOriginalMap(duid, vacuum, maps, originalMapId) {
    if (originalMapId === null) {
      return;
    }

    const currentMapId = this.getCurrentMapIdForDevice(duid);
    if (currentMapId === null || currentMapId === originalMapId) {
      return;
    }

    const originalMap = maps.find((map) => map.mapId === originalMapId);
    this.log.info(
      `Restoring Roborock map '${originalMap?.name || originalMapId}' for ${this.describeDevice(duid)} after caching Matter Service Area rooms.`
    );

    try {
      await vacuum.command(duid, "load_multi_map", originalMapId, {
        throwOnError: true,
      });
    } catch (error) {
      this.log.warn(
        `Failed to restore Roborock map '${originalMap?.name || originalMapId}' for ${this.describeDevice(duid)} after caching Matter Service Area rooms: ${error.message || error}. The robot may stay on another saved map until the next refresh.`
      );
    }
  }

  getCachedVacuumState(duid) {
    const cachedState = this.getStateAsync(
      `Devices.${duid}.deviceStatus.state`
    );
    const cachedValue = Number(cachedState?.val);
    if (Number.isFinite(cachedValue)) {
      return cachedValue;
    }

    const deviceStatus = this.getVacuumDeviceInfo(duid, "deviceStatus");
    const homeDataValue = Number(deviceStatus?.state);
    return Number.isFinite(homeDataValue) ? homeDataValue : null;
  }

  getServiceAreaRoomMapRefreshKey(duid, mapId) {
    return `${duid}:${mapId}`;
  }

  clearTimersAndIntervals() {
    if (this.reconnectIntervall) {
      this.clearInterval(this.reconnectIntervall);
    }
    if (this.homedataInterval) {
      this.clearInterval(this.homedataInterval);
    }
    if (this.commandTimeout) {
      this.clearTimeout(this.commandTimeout);
    }

    this.localConnector.clearLocalDevicedTimeout();

    // The MQTT startup watchdog is armed in initMQTT_Subscribe and would
    // otherwise survive shutdown and fire into a torn-down adapter.
    this.rr_mqtt_connector?.clearInitialConnectTimeout?.();

    for (const duid in this.vacuums) {
      this.clearInterval(this.vacuums[duid].getStatusIntervalHandle);
      this.clearInterval(this.vacuums[duid].mainUpdateIntervalHandle);
      this.vacuums[duid].getStatusIntervalHandle = null;
      this.vacuums[duid].mainUpdateIntervalHandle = null;
    }

    if (this.b01StatusLoopHandle) {
      this.clearInterval(this.b01StatusLoopHandle);
      this.b01StatusLoopHandle = null;
    }

    this.messageQueue.forEach(({ timeout102, timeout301 }) => {
      this.clearTimeout(timeout102);
      if (timeout301) {
        this.clearTimeout(timeout301);
      }
    });

    // Clear the messageQueue map
    this.messageQueue.clear();

    if (this.webSocketInterval) {
      this.clearInterval(this.webSocketInterval);
    }
  }

  checkAndClearRequest(requestId) {
    const request = this.messageQueue.get(requestId);
    if (!request?.timeout102 && !request?.timeout301) {
      this.messageQueue.delete(requestId);
      // this.log.debug(`Cleared messageQueue`);
    } else {
      this.log.debug(
        `Not clearing messageQueue. ${request.timeout102}  - ${request.timeout301}`
      );
    }
    this.log.debug(`Length of message queue: ${this.messageQueue.size}`);
  }

  async updateHomeData(homeId) {
    this.log.debug(`Updating HomeData with homeId: ${homeId}`);
    if (this.api) {
      try {
        const home = await this.api.get(`user/homes/${homeId}`);
        const homedata = home.data.result;

        if (homedata) {
          this.superviseB01DeviceIntervals();
          await this.refreshLocalKeysFromHomeData(homedata);
          await this.setStateAsync("HomeData", {
            val: JSON.stringify(homedata),
            ack: true,
          });
          this.log.debug(`homedata successfully updated`);

          await this.updateDeviceInfo(homedata.devices);
          await this.updateDeviceInfo(homedata.receivedDevices);
        } else {
          this.log.warn("homedata failed to download");
        }
      } catch (error) {
        this.log.error(`Failed to update updateHomeData with error: ${error}`);
      }
    }
  }

  async updateDeviceInfo(devices) {
    devices = this.normalizeArray(devices);
    for (const device in devices) {
      const duid = devices[device].duid;

      for (const deviceAttribute in devices[device]) {
        if (typeof devices[device][deviceAttribute] != "object") {
          let unit;
          if (deviceAttribute == "activeTime") {
            unit = "h";
            devices[device][deviceAttribute] = Math.round(
              devices[device][deviceAttribute] / 1000 / 60 / 60
            );
          }
          await this.setObjectAsync(
            "Devices." + duid + ".deviceInfo." + deviceAttribute,
            {
              type: "state",
              common: {
                name: deviceAttribute,
                type: this.getType(devices[device][deviceAttribute]),
                unit: unit,
                role: "value",
                read: true,
                write: false,
              },
              native: {},
            }
          );
          this.setStateChangedAsync(
            "Devices." + duid + ".deviceInfo." + deviceAttribute,
            { val: devices[device][deviceAttribute], ack: true }
          );
        }
      }
    }
  }

  async checkForNewFirmware(duid) {
    const isLocalDevice = !this.isRemoteDevice(duid);

    if (isLocalDevice) {
      this.log.debug(`getting firmware status`);
      if (this.api) {
        try {
          const update = await this.api.get(`ota/firmware/${duid}/updatev2`);

          await this.setObjectNotExistsAsync(
            "Devices." + duid + ".updateStatus",
            {
              type: "folder",
              common: {
                name: "Update status",
              },
              native: {},
            }
          );

          for (const state in update.data.result) {
            await this.setObjectNotExistsAsync(
              "Devices." + duid + ".updateStatus." + state,
              {
                type: "state",
                common: {
                  name: state,
                  type: this.getType(update.data.result[state]),
                  role: "value",
                  read: true,
                  write: false,
                },
                native: {},
              }
            );
            this.setStateAsync("Devices." + duid + ".updateStatus." + state, {
              val: update.data.result[state],
              ack: true,
            });
          }
        } catch (error) {
          this.catchError(error, "checkForNewFirmware()", duid);
        }
      }
    }
  }

  getType(attribute) {
    // Get the type of the attribute.
    const type = typeof attribute;

    // Return the appropriate string representation of the type.
    switch (type) {
      case "boolean":
        return "boolean";
      case "number":
        return "number";
      default:
        return "string";
    }
  }

  async createStateObjectHelper(
    path,
    name,
    type,
    unit,
    def,
    role,
    read,
    write,
    states,
    native = {}
  ) {
    const common = {
      name: name,
      type: type,
      unit: unit,
      role: role,
      read: read,
      write: write,
      states: states,
    };

    if (def !== undefined && def !== null && def !== "") {
      common.def = def;
    }

    this.setObjectAsync(path, {
      type: "state",
      common: common,
      native: native,
    });
  }

  createDeviceObject(pathSegment, duid, state, type, states, options = {}) {
    const {
      write = false,
      unit,
      hasUnit = false,
      def,
      hasDef = false,
    } = options;
    const path = `Devices.${duid}.${pathSegment}.${state}`;
    const name = this.translations[state];

    const common = {
      name: name,
      type: type,
      role: "value",
    };

    if (hasUnit) {
      common.unit = unit;
    }

    common.read = true;
    common.write = write;

    if (hasDef) {
      common.def = def;
    }

    common.states = states;

    this.setObjectAsync(path, {
      type: "state",
      common: common,
      native: {},
    });
  }

  async createCommand(duid, command, type, defaultState, states) {
    this.createDeviceObject("commands", duid, command, type, states, {
      write: true,
      hasDef: true,
      def: defaultState,
    });
  }

  async createDeviceStatus(duid, state, type, states, unit) {
    this.createDeviceObject("deviceStatus", duid, state, type, states, {
      write: false,
      hasUnit: true,
      unit,
    });
  }

  async createDockingStationObject(duid) {
    for (const state of dockingStationStates) {
      const path = `Devices.${duid}.dockingStationStatus.${state}`;
      const name = this.translations[state];

      this.setObjectNotExistsAsync(path, {
        type: "state",
        common: {
          name: name,
          type: "number",
          role: "value",
          read: true,
          write: false,
          states: { 0: "UNKNOWN", 1: "ERROR", 2: "OK" },
        },
        native: {},
      });
    }
  }

  async createConsumable(duid, state, type, states, unit) {
    this.createDeviceObject("consumables", duid, state, type, states, {
      write: false,
      hasUnit: true,
      unit,
    });
  }

  async createResetConsumables(duid, state) {
    const path = `Devices.${duid}.resetConsumables.${state}`;
    const name = this.translations[state];

    this.setObjectNotExistsAsync(path, {
      type: "state",
      common: {
        name: name,
        type: "boolean",
        role: "value",
        read: true,
        write: true,
        def: false,
      },
      native: {},
    });
  }

  async createCleaningRecord(duid, state, type, states, unit) {
    let start = 0;
    let end = 19;
    const robotModel = this.getProductAttribute(duid, "model");
    if (robotModel == "roborock.vacuum.a97") {
      start = 1;
      end = 20;
    }

    for (let i = start; i <= end; i++) {
      await this.setObjectAsync(`Devices.${duid}.cleaningInfo.records.${i}`, {
        type: "folder",
        common: {
          name: `Cleaning record ${i}`,
        },
        native: {},
      });

      this.setObjectAsync(
        `Devices.${duid}.cleaningInfo.records.${i}.${state}`,
        {
          type: "state",
          common: {
            name: this.translations[state],
            type: type,
            role: "value",
            unit: unit,
            read: true,
            write: false,
            states: states,
          },
          native: {},
        }
      );

      await this.setObjectAsync(
        `Devices.${duid}.cleaningInfo.records.${i}.map`,
        {
          type: "folder",
          common: {
            name: "Map",
          },
          native: {},
        }
      );
      for (const name of ["mapBase64", "mapBase64Truncated", "mapData"]) {
        const objectString = `Devices.${duid}.cleaningInfo.records.${i}.map.${name}`;
        await this.createStateObjectHelper(
          objectString,
          name,
          "string",
          null,
          null,
          "value",
          true,
          false
        );
      }
    }
  }

  async createCleaningInfo(duid, key, object) {
    const path = `Devices.${duid}.cleaningInfo.${key}`;
    const name = this.translations[object.name];

    this.setObjectAsync(path, {
      type: "state",
      common: {
        name: name,
        type: "number",
        role: "value",
        unit: object.unit,
        read: true,
        write: false,
      },
      native: {},
    });
  }

  async createBaseRobotObjects(duid) {
    for (const name of ["mapBase64", "mapBase64Truncated", "mapData"]) {
      const objectString = `Devices.${duid}.map.${name}`;
      await this.createStateObjectHelper(
        objectString,
        name,
        "string",
        null,
        null,
        "value",
        true,
        false
      );
    }

    this.createNetworkInfoObjects(duid);
  }

  async createBasicVacuumObjects(duid) {
    this.createNetworkInfoObjects(duid);
  }

  async createBasicWashingMachineObjects(duid) {
    return this.createBasicVacuumObjects(duid);
  }

  async createNetworkInfoObjects(duid) {
    for (const name of ["ssid", "ip", "mac", "bssid", "rssi"]) {
      const objectString = `Devices.${duid}.networkInfo.${name}`;
      const objectType = name == "rssi" ? "number" : "string";
      await this.createStateObjectHelper(
        objectString,
        name,
        objectType,
        null,
        null,
        "value",
        true,
        false
      );
    }
  }

  async startCommand(duid, command, parameters, options = {}) {
    if (!this.isInited()) {
      this.log.warn(
        `Command for ${this.describeDevice(duid)} was dropped because the Roborock connection has not finished starting up. Try again in a few seconds.`
      );
      return;
    }

    // Matter/HomeKit controllers can send commands immediately after a bridge
    // restart, before Roborock login and createDevices() have populated
    // this.vacuums. Fail with a classifiable error instead of a raw TypeError
    // so callers can log a clear "still starting up" message and recover.
    if (!this.vacuums[duid]) {
      // The thrown message keeps the "is not initialized" phrase because
      // isDeviceNotReadyError() matches on it. The line a user reads is built
      // separately and names the robot — passing the Error's message straight
      // to log.warn put a raw 22-character duid in front of them, and hid it
      // from the naming rule by laundering it through an Error.
      const notReadyError = new Error(
        `Roborock device ${duid} is not initialized yet; the plugin is still starting up or the device is missing from the account.`
      );
      notReadyError.code = "ROBOROCK_DEVICE_NOT_READY";
      if (options.waitForResult || options.throwOnError) {
        throw notReadyError;
      }

      this.log.warn(
        `${this.describeDevice(duid)} is not ready yet; the plugin is still starting up, or the robot is missing from your Roborock account. Try again in a few seconds.`
      );
      return;
    }

    const { waitForResult, commandOptions } = this.buildCommandOptions(options);

    if (SIMPLE_VACUUM_COMMANDS.has(command)) {
      const commandPromise = this.vacuums[duid].command(
        duid,
        command,
        parameters,
        commandOptions
      );
      if (waitForResult) {
        await commandPromise;
      }
    } else if (command === "get_photo") {
      this.vacuums[duid].getParameter(duid, "get_photo", parameters);
    } else {
      this.log.warn(`Command ${command} not found.`);
    }
  }

  isCleaning(state) {
    switch (state) {
      case 4: // Remote Control
      case 5: // Cleaning
      case 6: // Returning Dock
      case 7: // Manual Mode
      case 11: // Spot Cleaning
      case 15: // Docking
      case 16: // Go To
      case 17: // Zone Clean
      case 18: // Room Clean
      case 26: // Going to wash the mop
        return true;
      default:
        return false;
    }
  }

  async getRobotVersion(duid) {
    const device = this.getAllHomeDevices().find(
      (device) => device.duid == duid
    );
    if (device) {
      return device.pv;
    }

    return "Error in getRobotVersion. Version not found.";
  }

  getRequestId() {
    // Wrap without handing out the same id twice: the previous version
    // returned 0 at the wrap AND on the following call, colliding two
    // pending requests every 10,000 messages.
    if (this.idCounter >= 9999) {
      this.idCounter = 0;
    }
    return this.idCounter++;
  }

  async catchError(error, attribute, duid, model) {
    if (error) {
      const errorText = error.toString();

      // Methods without a B01/Q7 equivalent are an expected condition on
      // those robots, not a failure; keep the log calm.
      if (
        error &&
        typeof error === "object" &&
        error.code === "B01_METHOD_UNSUPPORTED"
      ) {
        this.log.debug(errorText);
        return;
      }

      const transientErrorKind =
        (typeof error === "object" && error?.transientKind) ||
        this.getTransientErrorKind(errorText);
      // Some callers only pass a message (no attribute/duid). Do not render
      // "Failed to execute undefined on robot undefined (unknown model)" for
      // those; log the message as-is instead.
      const hasContext = attribute !== undefined || duid !== undefined;
      const message = hasContext
        ? `Failed to execute ${attribute} on robot ${this.describeDevice(duid)} (${model || "unknown model"}): ${error}`
        : String(error);

      if (transientErrorKind) {
        const throttledWarning = this.getThrottledTransientWarning(
          transientErrorKind,
          attribute,
          duid,
          model,
          message
        );

        if (throttledWarning) {
          this.log.warn(throttledWarning);
        } else {
          this.log.debug(
            `Suppressed transient ${transientErrorKind} warning for ${attribute} on robot ${duid} (${model || "unknown model"}): ${error}`
          );
        }
      } else {
        this.log.error(
          hasContext
            ? `Failed to execute ${attribute} on robot ${this.describeDevice(duid)} (${model || "unknown model"}): ${error.stack || error}`
            : String(error.stack || error)
        );
      }
    }
  }

  getTransientErrorKind(errorText) {
    const text = String(errorText || "");

    if (/timed out after \d+ seconds/.test(text)) {
      if (text.includes("Local request")) {
        return "local timeout";
      }
      if (text.includes("Cloud request")) {
        return "cloud timeout";
      }
      return "timeout";
    }

    // `messageQueueHandler.sendRequest` declines to put a request on the wire
    // when the transport it would need is not there. It writes its own calm
    // debug line at the refusal site, so the rejection describes a transport
    // condition, not a plugin failure — logging it as an error with a stack
    // trace once per poll buried real problems whenever a robot dropped off
    // the Roborock cloud. Each reason keeps its own kind so that one outage
    // does not silence the reporting of another.
    // Kept as a fallback for a refusal that arrives as a plain string — the
    // reason normally travels on the error as `transientKind`, which is what
    // the caller above prefers. Matching on prose is what made a wording
    // change able to turn a calm transport condition back into an error with
    // a stack trace once per poll.
    if (/Not sending method .+ request\./.test(text)) {
      if (text.includes("is offline")) {
        return "device offline";
      }
      if (
        /cloud connection is not available|Cloud connection not available/.test(
          text
        )
      ) {
        return "cloud unavailable";
      }
      if (/No local connection to|Local connection not available/.test(text)) {
        return "local connection unavailable";
      }

      return "transport unavailable";
    }

    if (text.includes("retry")) {
      return "retry";
    }

    if (text.includes("locating")) {
      return "locating";
    }

    return null;
  }

  getThrottledTransientWarning(kind, attribute, duid, model, message) {
    if (this.errorLogThrottleMs <= 0) {
      return null;
    }

    const now = this.now();
    const key = [kind, duid, model || "unknown model"].join("|");
    const previous = this.errorLogThrottle.get(key);

    if (!previous || now - previous.lastLoggedAt >= this.errorLogThrottleMs) {
      const suppressedCount = previous?.suppressedCount || 0;
      const suppressedAttributes = previous?.suppressedAttributes || {};
      this.errorLogThrottle.set(key, {
        lastLoggedAt: now,
        suppressedCount: 0,
        suppressedAttributes: {},
      });

      const throttleNote = ` Future transient ${kind} warnings for this robot will be logged at most once every ${this.formatThrottleDuration(this.errorLogThrottleMs)}.`;
      const summaryNote =
        suppressedCount > 0
          ? ` ${suppressedCount} similar warning(s) across ${this.formatSuppressedAttributes(suppressedAttributes)} were suppressed.`
          : "";

      return `${message}${summaryNote}${throttleNote}`;
    }

    previous.suppressedCount = (previous.suppressedCount || 0) + 1;
    previous.suppressedAttributes = previous.suppressedAttributes || {};
    previous.suppressedAttributes[attribute || "unknown command"] =
      (previous.suppressedAttributes[attribute || "unknown command"] || 0) + 1;
    this.errorLogThrottle.set(key, previous);
    return null;
  }

  formatSuppressedAttributes(attributes) {
    const entries = Object.entries(attributes || {});

    if (entries.length === 0) {
      return "this robot";
    }

    return entries
      .map(([attribute, count]) => `${attribute} (${count})`)
      .join(", ");
  }

  formatThrottleDuration(durationMs) {
    if (durationMs >= 60 * 1000) {
      return `${Math.round(durationMs / (60 * 1000))} minutes`;
    }

    return `${Math.max(1, Math.round(durationMs / 1000))} seconds`;
  }

  async app_start(duid, options) {
    await this.startCommand(duid, "app_start", null, options);
  }

  async app_stop(duid, options) {
    await this.startCommand(duid, "app_stop", null, options);
  }

  async app_pause(duid, options) {
    await this.startCommand(duid, "app_pause", null, options);
  }

  async app_charge(duid, options) {
    await this.startCommand(duid, "app_charge", null, options);
  }

  async find_me(duid, options) {
    await this.startCommand(duid, "find_me", null, options);
  }

  async app_segment_clean_by_ids(duid, segments, options = {}) {
    await this.startCommand(
      duid,
      "app_segment_clean_by_ids",
      {
        segments,
        repeat: options.repeat,
      },
      options
    );
  }

  async load_multi_map(duid, mapId, options = {}) {
    await this.startCommand(duid, "load_multi_map", mapId, options);
  }

  async getServerTimers(duid, options = {}) {
    if (!this.vacuums[duid]) {
      throw new Error(
        `Vacuum ${this.describeDevice(duid)} is not initialized.`
      );
    }

    return await this.vacuums[duid].getServerTimers(duid, options);
  }

  async updateServerTimer(duid, timerId, enabled, options = {}) {
    if (!this.vacuums[duid]) {
      throw new Error(
        `Vacuum ${this.describeDevice(duid)} is not initialized.`
      );
    }

    return await this.vacuums[duid].updateServerTimer(
      duid,
      timerId,
      enabled,
      options
    );
  }

  async getStatus(duid, options = {}) {
    try {
      if (!this.vacuums[duid]) {
        this.log.debug(
          `Skipping status refresh for ${this.describeDevice(duid)}; the Roborock device runtime is not initialized yet.`
        );
        return;
      }

      const robotVersion = await this.getRobotVersion(duid);
      if (b01Q7Adapter.isB01Protocol(robotVersion)) {
        await this.refreshB01Status(duid, options);
        return;
      }

      const attribute = options.force ? "force" : "state";
      const parameterOptions = options.preferCloud
        ? { preferCloud: true }
        : undefined;
      if (parameterOptions) {
        await this.vacuums[duid].getParameter(
          duid,
          "get_status",
          attribute,
          parameterOptions
        );
        return;
      }

      await this.vacuums[duid].getParameter(duid, "get_status", attribute);
    } catch (error) {
      this.catchError(error, "getStatus", duid);
    }
  }

  /**
   * The freshest status this robot has actually reported, if the dedicated B01
   * poll loop has already had a successful answer for it.
   *
   * The loop keeps this so a later full cluster rebuild can prefer it over the
   * slower HomeData snapshot. It is exposed because the accessory that needs it
   * may not exist yet at the moment it arrives: discovery runs in the
   * startService callback, so a live frame can be dropped twice over in silence
   * — `notifyVacuumByDuid` finds no accessory for the duid, and
   * `updateMatterStateFromMessage` returns early while `registered` is false —
   * with nothing to redeliver it afterwards. Reading it back is what lets a
   * newly usable accessory start from the robot's real status instead of the
   * pairing-day snapshot.
   *
   * Only the cloud-only B01 dialect keeps such a store; classic robots stream
   * their status over MQTT and have no equivalent gap, so this answers `null`
   * for them and callers must treat that as "nothing known", never as a value.
   *
   * @param {string} duid
   * @returns {Record<string, unknown> | null}
   */
  getLastKnownLiveStatus(duid) {
    return this._b01StatusState?.get(duid)?.lastV1Status || null;
  }

  async refreshB01Status(duid, options = {}) {
    // Q7/B01 status snapshot via prop.get, mapped to v1-shaped fields and
    // dispatched on the existing live-message path so the Matter accessory
    // updates exactly like it does for classic robots.
    //
    // The 1-second poll tick relies on getParameter's internal throttling for
    // classic robots; this path must throttle itself or every tick becomes a
    // cloud request. Periodic refreshes are paced by the adaptive cadence
    // below, forced
    // refreshes (post-command, robot pushes) at most every 1.5s, and
    // concurrent callers share one in-flight request.
    if (!this._b01StatusState) {
      this._b01StatusState = new Map();
    }
    let refreshState = this._b01StatusState.get(duid);
    if (!refreshState) {
      refreshState = {
        lastAttemptAt: 0,
        inflight: null,
        consecutiveFailures: 0,
      };
      this._b01StatusState.set(duid, refreshState);
    }

    if (refreshState.inflight) {
      return refreshState.inflight;
    }

    // Throttle on ATTEMPTS, not successes: a robot or cloud that stops
    // answering must not turn the 1-second poll tick into a retry storm.
    // Adaptive cadence: while the robot is actively working (cleaning,
    // returning, docking) every 15s loop tick is allowed through so state
    // transitions reach Matter controllers within seconds; at rest the
    // conservative cadence below applies.
    const isActive = B01_ACTIVE_V1_STATES.has(refreshState.lastKnownV1State);
    // 45s while idle was the dominant part of the delay before a run showed
    // up at all: a clean started from the Roborock app or a schedule is
    // invisible to the plugin until the next poll gets through. 25s halves
    // that worst case for one extra request per robot per minute while
    // parked, which is negligible next to the active cadence.
    const minimumGapMs = options.force
      ? B01_STATUS_FORCED_GAP_MS
      : isActive
        ? B01_STATUS_ACTIVE_GAP_MS
        : B01_STATUS_IDLE_GAP_MS;
    if (Date.now() - refreshState.lastAttemptAt < minimumGapMs) {
      return null;
    }
    refreshState.lastAttemptAt = Date.now();

    refreshState.inflight = (async () => {
      try {
        const data = await this.messageQueueHandler.sendRequest(
          duid,
          "get_status",
          []
        );
        const v1Status = b01Q7Adapter.mapStatusToV1(
          data,
          b01Q7Adapter.b01FamilyForModel(
            this.getProductAttribute(duid, "model")
          )
        );
        // A run that has just started is the moment the user is watching, and
        // it was also the slowest: the live-room fetch below rides its own
        // throttle, counted from the last attempt, so the first room of a run
        // could wait a further gap on top of the poll that noticed the robot
        // at all. Clearing the stamp on the idle -> active transition makes
        // that first fetch immediate; the throttle still paces every fetch
        // after it.
        const wasFetching = B01_LIVE_ROOM_FETCH_V1_STATES.has(
          refreshState.lastKnownV1State
        );
        const isFetching = B01_LIVE_ROOM_FETCH_V1_STATES.has(v1Status.state);
        if (isFetching && !wasFetching) {
          const liveState = this._b01LiveRoomState?.get(duid);
          if (liveState) {
            liveState.lastAttemptAt = 0;
          }
        }
        refreshState.lastKnownV1State = v1Status.state;
        refreshState.lastV1Status = v1Status;

        if (refreshState.consecutiveFailures > 0) {
          this.log.info(
            `B01 status for ${this.describeDevice(duid)} recovered after ${refreshState.consecutiveFailures} failed attempt(s) (the attempts themselves are debug-level).`
          );
        }
        refreshState.consecutiveFailures = 0;

        if (!refreshState.firstSuccessLogged) {
          refreshState.firstSuccessLogged = true;
          this.log.info(
            `B01 status online for ${this.describeDevice(duid)}: state=${v1Status.state}, battery=${v1Status.battery ?? "?"}%, charging=${v1Status.charge_status === 1 ? "yes" : "no"}.`
          );
        }

        // Template args are evaluated even when debug logging is off, and
        // this line runs on every successful poll — gate the stringify.
        if (this.config.debug) {
          this.log.debug(
            `B01 status for ${duid}: ${JSON.stringify(data)} -> ${JSON.stringify(v1Status)}`
          );
        }

        if (this.deviceNotify !== undefined) {
          this.deviceNotify("CloudMessage", { duid, payload: [v1Status] });
        }

        if (B01_LIVE_ROOM_FETCH_V1_STATES.has(v1Status.state)) {
          // Fire-and-forget: the live-room refresh has its own throttle and
          // single-flight guard, and a map fetch failure must never disturb
          // the status flow.
          void this.refreshB01LiveRoom(duid).catch(() => undefined);
        } else if (B01_LIVE_ROOM_CLEAR_V1_STATES.has(v1Status.state)) {
          this.clearB01LiveRoom(duid);
        }

        return v1Status;
      } catch (error) {
        refreshState.consecutiveFailures += 1;
        const message = error?.message || String(error);
        if (refreshState.consecutiveFailures % 10 === 0) {
          this.log.warn(
            `B01 status has failed ${refreshState.consecutiveFailures} times in a row for ${this.describeDevice(duid)}. Last error: ${message}`
          );
        } else {
          this.log.debug(
            `B01 status attempt ${refreshState.consecutiveFailures} failed for ${duid}: ${message}`
          );
        }
        return null;
      } finally {
        refreshState.inflight = null;
      }
    })();

    return refreshState.inflight;
  }

  /**
   * B01 robots never enter the v1 getParameter flow that normally restarts
   * device intervals after an offline period, so one online flap would kill
   * their status polling forever. Called from the periodic HomeData refresh
   * as a supervisor: restarts intervals when a B01 robot is back online.
   */
  superviseB01DeviceIntervals() {
    this.startB01StatusLoop();

    for (const duid of this.initializedVacuumDuids) {
      if (
        this.getVacuumDeviceInfo(duid, "pv") ===
        b01Q7Adapter.B01_PROTOCOL_VERSION
      ) {
        void this.manageDeviceIntervals(duid).catch(() => undefined);
      }
    }
  }

  /**
   * Dedicated status loop for B01/Q7 robots, independent of the fragile
   * per-device v1 interval machinery. Ticks every 15 seconds and asks
   * getStatus for every initialized B01 device; the attempt throttle keeps
   * the effective cloud cadence at ~45s. Idempotent: safe to call from the
   * HomeData supervisor, which revives the loop if anything cleared it.
   */
  startB01StatusLoop() {
    if (this.b01StatusLoopHandle) {
      return;
    }

    const hasB01Device = [...this.initializedVacuumDuids].some(
      (duid) =>
        this.getVacuumDeviceInfo(duid, "pv") ===
        b01Q7Adapter.B01_PROTOCOL_VERSION
    );
    if (!hasB01Device) {
      return;
    }

    this.log.info(
      `Starting the dedicated B01/Q7 status loop (${B01_STATUS_TICK_MS / 1000}s tick; ~${B01_STATUS_ACTIVE_GAP_MS / 1000}s effective cadence while active, ~${B01_STATUS_IDLE_GAP_MS / 1000}s at rest).`
    );
    const pollAllB01 = (options) => {
      for (const duid of this.initializedVacuumDuids) {
        if (
          this.getVacuumDeviceInfo(duid, "pv") ===
          b01Q7Adapter.B01_PROTOCOL_VERSION
        ) {
          void this.getStatus(duid, options).catch(() => undefined);
        }
      }
    };

    // First poll immediately: after a restart the Matter store holds the
    // registration snapshot (HomeData fallback), and the sooner the real
    // values land, the sooner controllers receive a genuine change report.
    //
    // But only into a cloud session that is actually up. A B01 request is
    // cloud-only, so one issued before the MQTT session is established is
    // refused before it reaches the wire — and a refused attempt still stamps
    // the attempt throttle, which pushes the retry past the 15s tick and into
    // the one at 30s. Skipping the attempt costs nothing and buys both: no
    // spurious "recovered after 1 failed attempt(s)" line, and a first real
    // status at the next tick instead of the one after it.
    //
    // A connector that cannot answer the question is treated as usable, so a
    // caller without a live connector keeps the behaviour it always had.
    const cloudSessionUp =
      typeof this.rr_mqtt_connector?.isConnected === "function"
        ? this.rr_mqtt_connector.isConnected()
        : true;
    if (cloudSessionUp) {
      pollAllB01({ force: true });
    } else {
      this.log.debug(
        "Holding the first B01/Q7 status poll until the Roborock cloud session is up; the loop tick will take it."
      );
    }
    this.b01StatusLoopHandle = this.setInterval(pollAllB01, B01_STATUS_TICK_MS);
    if (typeof this.b01StatusLoopHandle?.unref === "function") {
      this.b01StatusLoopHandle.unref();
    }
  }

  getB01RoomCache(duid) {
    const stored = this.getStateAsync("B01Rooms");
    if (stored && typeof stored.val === "string") {
      try {
        const all = JSON.parse(stored.val);
        const rooms = all?.[duid];
        return Array.isArray(rooms) ? rooms : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  async setB01RoomCache(duid, rooms) {
    const stored = this.getStateAsync("B01Rooms");
    let all = {};
    if (stored && typeof stored.val === "string") {
      try {
        all = JSON.parse(stored.val) || {};
      } catch {
        all = {};
      }
    }
    all[duid] = rooms;
    await this.setStateAsync("B01Rooms", {
      val: JSON.stringify(all),
      ack: true,
    });
  }

  /**
   * Fetch and cache the Q7 room list: map list -> current map id ->
   * service.upload_by_mapid -> MAP_RESPONSE (protocol 301) -> AES-ECB/zlib
   * decode -> SCMap protobuf -> {roomId, roomName}. Rooms rarely change, so
   * refreshes are throttled to once per 6 hours unless forced.
   */
  async refreshB01Rooms(duid, options = {}) {
    if (!this._b01RoomRefreshAt) {
      this._b01RoomRefreshAt = new Map();
    }
    const lastAt = this._b01RoomRefreshAt.get(duid) || 0;
    if (!options.force && Date.now() - lastAt < 6 * 60 * 60 * 1000) {
      return this.getB01RoomCache(duid);
    }

    const mapListData = await this.messageQueueHandler.sendRequest(
      duid,
      "get_map_list",
      {}
    );
    const mapId = b01Q7Adapter.findCurrentMapId(mapListData);
    if (mapId === null) {
      this.log.debug(`No B01 map available yet for ${duid}; rooms deferred.`);
      return this.getB01RoomCache(duid);
    }

    const rawPayload = await this.sendB01MapRequest(duid, mapId);
    const serial = this.getVacuumDeviceInfo(duid, "sn");
    const model = this.getProductAttribute(duid, "model");
    const mapKey = b01Q7Adapter.createMapKey(serial, model);
    const scMap = b01Q7Adapter.decodeMapPayload(rawPayload, mapKey);
    const rooms = b01Q7Adapter.parseRoomsFromScMap(scMap);

    this._b01RoomRefreshAt.set(duid, Date.now());
    await this.setB01RoomCache(duid, rooms);
    this.log.info(
      `B01 rooms for ${this.describeDevice(duid)}: ${rooms.length ? rooms.map((room) => `${room.roomName || "?"} (${room.roomId})`).join(", ") : "none reported"}.`
    );
    return rooms;
  }

  async sendB01MapRequest(duid, mapId) {
    if (!this.pendingB01MapRequests) {
      this.pendingB01MapRequests = new Map();
    }
    const existing = this.pendingB01MapRequests.get(duid);
    if (existing) {
      return existing.promise;
    }

    const messageID = b01Q7Adapter.createB01MessageId();
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = await this.message.buildPayload(
      duid,
      101,
      messageID,
      b01Q7Adapter.B01_MAP_UPLOAD_METHOD,
      { map_id: mapId },
      false,
      false
    );
    const roborockMessage = await this.message.buildRoborockMessage(
      duid,
      101,
      timestamp,
      payload
    );
    if (!roborockMessage) {
      throw new Error(
        `Failed to build the B01 map request for ${this.describeDevice(duid)}.`
      );
    }

    let entry;
    const promise = new Promise((resolve, reject) => {
      const timeout = this.setTimeout(() => {
        this.pendingB01MapRequests.delete(duid);
        reject(
          new Error(
            `B01 map request timed out after 20s for ${this.describeDevice(duid)}.`
          )
        );
      }, 20000);
      if (typeof timeout?.unref === "function") {
        timeout.unref();
      }
      entry = { resolve, reject, timeout };
    });
    entry.promise = promise;
    this.pendingB01MapRequests.set(duid, entry);
    this.rr_mqtt_connector.sendMessage(duid, roborockMessage);
    return promise;
  }

  /**
   * Fetch the current SCMap and derive which room the robot is physically
   * inside (currentPose ray-cast against the per-room boundary chains).
   * Called from the B01 status loop while the robot is actively cleaning;
   * throttled on attempts (min 20s gap), single-flight per device, and
   * disabled entirely with the enableLiveRoomTracking=false config option.
   *
   * On a room CHANGE the cached last v1 status is re-broadcast through
   * deviceNotify so the Matter accessory rebuilds its Service Area cluster
   * promptly (unchanged clusters are suppressed by confirmed-publish
   * diffing, so the re-broadcast costs one Service Area write at most).
   * The fetched map also opportunistically refreshes the room-name cache,
   * postponing the next scheduled 6-hour room refresh.
   * @param {string} duid
   * @returns {Promise<{segmentId: number, roomName: string, at: number} | null>}
   */
  async refreshB01LiveRoom(duid) {
    if (this.config.enableLiveRoomTracking === false) {
      return null;
    }
    if (!this._b01LiveRoomState) {
      this._b01LiveRoomState = new Map();
    }
    let liveState = this._b01LiveRoomState.get(duid);
    if (!liveState) {
      liveState = {
        lastAttemptAt: 0,
        inflight: null,
        consecutiveFailures: 0,
        current: null,
      };
      this._b01LiveRoomState.set(duid, liveState);
    }

    if (liveState.inflight) {
      return liveState.inflight;
    }
    if (
      Date.now() - liveState.lastAttemptAt <
      liveRoomFetchGapMs(liveState.consecutiveFailures)
    ) {
      return liveState.current;
    }
    liveState.lastAttemptAt = Date.now();

    liveState.inflight = (async () => {
      try {
        const mapListData = await this.messageQueueHandler.sendRequest(
          duid,
          "get_map_list",
          {}
        );
        const mapId = b01Q7Adapter.findCurrentMapId(mapListData);
        if (mapId === null) {
          return liveState.current;
        }

        const rawPayload = await this.sendB01MapRequest(duid, mapId);
        const serial = this.getVacuumDeviceInfo(duid, "sn");
        const model = this.getProductAttribute(duid, "model");
        const mapKey = b01Q7Adapter.createMapKey(serial, model);
        const scMap = b01Q7Adapter.decodeMapPayload(rawPayload, mapKey);
        const parsed = b01Q7Adapter.parseScMapLiveState(scMap);

        // The live fetch already paid for the full map payload; reuse it to
        // keep the room-name cache fresh instead of scheduling another
        // 6-hour refreshB01Rooms fetch of the same data. Written only on
        // actual change — the cache is persisted to disk, and rewriting an
        // identical room list every ~20 s during cleaning is pure I/O waste.
        if (parsed.rooms.length > 0) {
          if (!this._b01RoomRefreshAt) {
            this._b01RoomRefreshAt = new Map();
          }
          this._b01RoomRefreshAt.set(duid, Date.now());
          const cachedRooms = JSON.stringify(this.getB01RoomCache(duid));
          if (cachedRooms !== JSON.stringify(parsed.rooms)) {
            await this.setB01RoomCache(duid, parsed.rooms);
          }
        }

        const resolution2 = b01Q7Adapter.describeLiveRoomResolution(parsed);
        const roomId = resolution2.roomId;
        this.noteLiveRoomFetchRecovered(duid, liveState);

        if (roomId === null) {
          // Debug-only used to make this invisible, and it is the single most
          // likely reason a run goes minutes without naming a room: in the
          // field a Q7 took 7 minutes to report its first room while every
          // attempt in between resolved to nothing and said so only at debug
          // level. Count the misses and say something at a level the user
          // actually sees, so "no room yet" is distinguishable from "the
          // feature is broken" — and say WHICH of the four causes it was,
          // because they call for different fixes.
          // A placeholder pose is not the robot failing to be in a room, so
          // it does not join the count that says how long the robot has gone
          // unplaced. Counting it produced "after 46 unresolved position(s)"
          // for a robot that had been cleaning one room the whole time, which
          // reads as a fault and is not one.
          //
          // It is said once per run at a level the user sees, with the numbers
          // that make it diagnosable, and then held at debug. In the field
          // that turns 226 info-and-debug lines per clean into one.
          if (resolution2.reason === "pose-placeholder") {
            const placeholderMessage = `Live room for ${this.describeDevice(duid)}: ${B01_LIVE_ROOM_MISS_REASONS[resolution2.reason]} (${resolution2.outlineCount} room outline(s) in the map${resolution2.cell ? `, position cell ${Math.round(resolution2.cell.x)},${Math.round(resolution2.cell.y)}` : ""}${describeOutlineBounds(resolution2)}).`;
            if (!liveState.placeholderReported) {
              liveState.placeholderReported = true;
              this.log.info(placeholderMessage);
            } else {
              this.log.debug(placeholderMessage);
            }
            return liveState.current;
          }

          liveState.unresolvedPoseCount =
            (liveState.unresolvedPoseCount || 0) + 1;
          const message = `Live room for ${this.describeDevice(duid)}: ${B01_LIVE_ROOM_MISS_REASONS[resolution2.reason]} (attempt ${liveState.unresolvedPoseCount} this run, ${resolution2.outlineCount} room outline(s) in the map${resolution2.cell ? `, position cell ${Math.round(resolution2.cell.x)},${Math.round(resolution2.cell.y)}` : ""}${describeOutlineBounds(resolution2)}${describeRawMapFields(parsed)}).`;
          if (liveState.unresolvedPoseCount % 5 === 0) {
            this.log.info(message);
          } else {
            this.log.debug(message);
          }
          return liveState.current;
        }
        const missedBeforeThis = liveState.unresolvedPoseCount || 0;
        liveState.unresolvedPoseCount = 0;

        const roomName =
          parsed.rooms.find((room) => room.roomId === roomId)?.roomName ||
          `Room ${roomId}`;
        const previous = liveState.current;
        liveState.current = { segmentId: roomId, roomName, at: Date.now() };

        if (previous && previous.segmentId === roomId && missedBeforeThis > 0) {
          // Re-entering the room it was already in resets the miss counter
          // without printing anything, which made the "attempt N" numbers look
          // as if they reset at random. Say it happened.
          this.log.info(
            `Live room for ${this.describeDevice(duid)}: back in ${roomName} (${roomId}) after ${missedBeforeThis} unresolved position(s).`
          );
        }

        if (!previous || previous.segmentId !== roomId) {
          this.log.info(
            `Live room for ${this.describeDevice(duid)}: ${roomName} (${roomId})${previous ? ` — was ${previous.roomName} (${previous.segmentId})` : ""}${missedBeforeThis > 0 ? ` (after ${missedBeforeThis} unresolved position(s))` : ""}${resolution2.cell ? ` [position cell ${Math.round(resolution2.cell.x)},${Math.round(resolution2.cell.y)}]` : ""}.`
          );
          const lastV1Status = this._b01StatusState?.get(duid)?.lastV1Status;
          if (this.deviceNotify && lastV1Status) {
            this.deviceNotify("CloudMessage", {
              duid,
              payload: [lastV1Status],
            });
          }
        }

        return liveState.current;
      } catch (error) {
        liveState.consecutiveFailures += 1;
        const message = error?.message || String(error);
        if (liveState.consecutiveFailures % 5 === 0) {
          this.log.warn(
            `Live-room map fetch has failed ${liveState.consecutiveFailures} times in a row for ${this.describeDevice(duid)}. Last error: ${message}`
          );
        } else {
          this.log.debug(
            `Live-room map fetch attempt failed for ${duid}: ${message}`
          );
        }
        return liveState.current;
      } finally {
        liveState.inflight = null;
      }
    })();

    return liveState.inflight;
  }

  /**
   * The robot's most recently derived live room, or null when unknown /
   * cleared / tracking disabled. segmentId matches the segmentId exposed by
   * getRoomMappingsForDevice for B01 robots (the SCMap roomId).
   * @param {string} duid
   * @returns {{segmentId: number, roomName: string, at: number} | null}
   */
  getB01LiveRoomForDevice(duid) {
    return this._b01LiveRoomState?.get(duid)?.current || null;
  }

  /**
   * Close the loop on a failure streak. "Live-room map fetch has failed N
   * times in a row" had no counterpart, so a channel that came back left the
   * last word in the log saying it was broken. Said exactly when the backoff
   * had begun slowing the fetch down, so the message and the behaviour it
   * reports on cannot drift apart.
   * @param {string} duid
   * @param {{consecutiveFailures?: number} | null | undefined} liveState
   */
  noteLiveRoomFetchRecovered(duid, liveState) {
    const failures = liveState?.consecutiveFailures || 0;
    if (failures > LIVE_ROOM_FAILURE_BACKOFF_AFTER) {
      this.log.info(
        `Live-room map fetch for ${this.describeDevice(duid)} recovered after ${failures} failed attempt(s).`
      );
    }
    if (liveState) {
      liveState.consecutiveFailures = 0;
    }
  }

  /** @param {string} duid */
  clearB01LiveRoom(duid) {
    const liveState = this._b01LiveRoomState?.get(duid);
    if (liveState?.current) {
      this.log.debug(
        `Cleared live room for ${this.describeDevice(duid)} (${liveState.current.roomName}).`
      );
      liveState.current = null;
    }
    resetLiveRoomRunCounters(liveState);
  }

  /**
   * Protocol-agnostic live-room entry points. B01/Q7 robots use the SCMap
   * channel (triggered internally by the B01 status loop as well); classic
   * v1 robots fetch the RRMap via the secure get_map_v1 request. Both share
   * the same cache contract: {segmentId, roomName, at} where segmentId
   * matches getRoomMappingsForDevice.
   * @param {string} duid
   * @param {{v1State?: number}} [context] latest known v1 state, used to
   *   avoid pointless map fetches and to re-broadcast on room changes.
   */
  async refreshLiveRoomForDevice(duid, context = {}) {
    if (this.config.enableLiveRoomTracking === false) {
      return null;
    }
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      return this.refreshB01LiveRoom(duid);
    }
    return this.refreshClassicLiveRoom(duid, context);
  }

  /**
   * @param {string} duid
   * @returns {{segmentId: number, roomName: string, at: number} | null}
   */
  getLiveRoomForDevice(duid) {
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      return this.getB01LiveRoomForDevice(duid);
    }
    return this._classicLiveRoomState?.get(duid)?.current || null;
  }

  /** @param {string} duid */
  clearLiveRoomForDevice(duid) {
    this.clearB01LiveRoom(duid);
    const liveState = this._classicLiveRoomState?.get(duid);
    if (liveState?.current) {
      this.log.debug(
        `Cleared live room for ${this.describeDevice(duid)} (${liveState.current.roomName}).`
      );
      liveState.current = null;
    }
    resetLiveRoomRunCounters(liveState);
  }

  /**
   * Classic v1 live room: fetch the RRMap via the secure get_map_v1 request
   * (protocol 301 response: AES/gzip handled by the transport layer),
   * parse it, and resolve the robot's position against the segment pixel
   * grid. Same attempt throttle, single-flight guard and change
   * re-broadcast semantics as the B01 path.
   * @param {string} duid
   * @param {{v1State?: number}} [context]
   */
  async refreshClassicLiveRoom(duid, context = {}) {
    if (this.config.enableLiveRoomTracking === false) {
      return null;
    }
    // Only fetch while the robot is actively moving through rooms; a paused
    // or docked robot cannot change rooms, and map payloads are heavy.
    if (
      Number.isInteger(context.v1State) &&
      !B01_LIVE_ROOM_FETCH_V1_STATES.has(context.v1State)
    ) {
      return this._classicLiveRoomState?.get(duid)?.current || null;
    }

    if (!this._classicLiveRoomState) {
      this._classicLiveRoomState = new Map();
    }
    let liveState = this._classicLiveRoomState.get(duid);
    if (!liveState) {
      liveState = {
        lastAttemptAt: 0,
        inflight: null,
        consecutiveFailures: 0,
        current: null,
        lastV1State: null,
      };
      this._classicLiveRoomState.set(duid, liveState);
    }
    if (Number.isInteger(context.v1State)) {
      liveState.lastV1State = context.v1State;
    }

    if (liveState.inflight) {
      return liveState.inflight;
    }
    if (Date.now() - liveState.lastAttemptAt < B01_LIVE_ROOM_MIN_FETCH_GAP_MS) {
      return liveState.current;
    }
    liveState.lastAttemptAt = Date.now();

    liveState.inflight = (async () => {
      try {
        const mapBuffer = await this.messageQueueHandler.sendRequest(
          duid,
          "get_map_v1",
          [],
          true
        );
        if (!Buffer.isBuffer(mapBuffer)) {
          this.log.debug(
            `Live-room map fetch for ${duid} returned a non-map response (${JSON.stringify(mapBuffer)?.slice(0, 80)}); keeping the previous room.`
          );
          return liveState.current;
        }

        // Fast path: reads the single pixel under the robot directly from
        // the raw buffer — no pixel arrays are materialized (parsedata costs
        // ~23 ms + ~6.7 MB of allocations on a real-size map; this is
        // microseconds).
        const segmentId =
          RRMapParser.resolveLiveSegmentFromMapBuffer(mapBuffer);
        this.noteLiveRoomFetchRecovered(duid, liveState);

        if (segmentId === null) {
          this.log.debug(
            `Live room for ${duid}: robot position has no segment assignment (or position/segments missing from the map).`
          );
          return liveState.current;
        }

        const room = this.getRoomMappingsForDevice(duid).find(
          (candidate) => Number(candidate.segmentId) === segmentId
        );
        const roomName = room?.name || `Room ${segmentId}`;
        const previous = liveState.current;
        liveState.current = { segmentId, roomName, at: Date.now() };

        if (!previous || previous.segmentId !== segmentId) {
          this.log.info(
            `Live room for ${this.describeDevice(duid)}: ${roomName} (${segmentId})${previous ? ` — was ${previous.roomName} (${previous.segmentId})` : ""}.`
          );
          if (this.deviceNotify && Number.isInteger(liveState.lastV1State)) {
            this.deviceNotify("CloudMessage", {
              duid,
              payload: [{ state: liveState.lastV1State }],
            });
          }
        }

        return liveState.current;
      } catch (error) {
        liveState.consecutiveFailures += 1;
        const message = error?.message || String(error);
        if (liveState.consecutiveFailures % 5 === 0) {
          this.log.warn(
            `Live-room map fetch has failed ${liveState.consecutiveFailures} times in a row for ${this.describeDevice(duid)}. Last error: ${message}`
          );
        } else {
          this.log.debug(
            `Live-room map fetch attempt failed for ${duid}: ${message}`
          );
        }
        return liveState.current;
      } finally {
        liveState.inflight = null;
      }
    })();

    return liveState.inflight;
  }

  getProductData(productId) {
    const products = this.getKnownProducts();
    return products.find((product) => product.id == productId);
  }

  getVacuumDeviceData(duid) {
    const devices = this.getAllHomeDevices();
    return devices.find((device) => device.duid == duid);
  }

  getVacuumSchemaId(duid, code) {
    const productId = this.getVacuumDeviceInfo(duid, "productId");
    const product = this.getProductData(productId);

    if (product) {
      const schema = product.schema;
      const schemaId = schema.find((schema) => schema.code == code);

      if (schemaId) {
        return schemaId.id;
      }
    }

    return null;
  }

  getVacuumDeviceInfo(duid, property) {
    const device = this.getVacuumDeviceData(duid);

    if (device) {
      return device[property];
    } else {
      return "";
    }
  }

  /**
   * A device's name for log messages, falling back to the duid.
   *
   * The live-room success line already used the friendly name while the
   * failure line printed a raw 22-character duid — so the one message written
   * specifically to identify a misbehaving robot was the one you could not
   * read. In a three-robot house that is the difference between a usable log
   * and a wall of identifiers.
   *
   * @param {string} duid
   * @returns {string}
   */
  describeDevice(duid) {
    const name = this.getVacuumDeviceInfo(duid, "name");

    return typeof name === "string" && name.length > 0 ? name : String(duid);
  }

  getVacuumDeviceStatus(duid, property) {
    const propertyID = this.getVacuumSchemaId(duid, property);

    if (propertyID == null) {
      return "";
    }

    // The device can disappear from HomeData between the schema lookup above
    // and this read (account changes, first start before HomeData persists).
    // Status reads are used by hot Matter/HomeKit paths, so they must never
    // throw; report "no value" instead.
    const device = this.getVacuumDeviceData(duid);
    if (!device) {
      return "";
    }

    // Q7/B01 robots report their native work-status codes in the cloud
    // deviceStatus snapshot (charging = 4, cleaning = 5/6/7, ...). Reading
    // them as v1 codes makes a charging robot look like "remote control
    // active", so translate the state attribute before anyone interprets it.
    if (
      property === "state" &&
      device.pv === b01Q7Adapter.B01_PROTOCOL_VERSION &&
      device.deviceStatus
    ) {
      const rawStatus = device.deviceStatus[propertyID];
      const translated = b01Q7Adapter.translateQ7WorkStatusToV1State(rawStatus);
      if (translated !== null) {
        return translated;
      }
    }

    if (device.deviceStatus) {
      if (device.deviceStatus[propertyID] != undefined) {
        return device.deviceStatus[propertyID];
      }

      if (device.deviceStatus[property] != undefined) {
        return device.deviceStatus[property];
      }
    }

    return "";
  }

  getVacuumList() {
    return this.getAllHomeDevices();
  }

  setDeviceNotify(callback) {
    this.deviceNotify = callback;
  }
}

module.exports = {
  Roborock,
  CLOUD_ONLY_TRANSPORT_MARKERS,
  UNEXPLAINED_REMOTE_REASON,
  LOCAL_MUTE_REMOTE_REASON,
  LOCAL_MUTE_TIMEOUT_LIMIT,
};

////////////////////////////////////////////////////////////////////////////////////////////////////
