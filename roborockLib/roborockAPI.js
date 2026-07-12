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
const roborockPackageHelper =
  require("./lib/roborockPackageHelper").roborockPackageHelper;
const deviceFeatures = require("./lib/deviceFeatures").deviceFeatures;
const messageQueueHandler =
  require("./lib/messageQueueHandler").messageQueueHandler;
const roborockCrypto = require("./lib/roborockCrypto");
const b01Q7Adapter = require("./lib/b01Q7Adapter");

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

    this.roborockPackageHelper = new roborockPackageHelper(this);

    this.localConnector = new rrLocalConnector(this);
    this.rr_mqtt_connector = new roborock_mqtt_connector(this);
    this.message = new rrMessage(this);

    this.messageQueueHandler = new messageQueueHandler(this);

    this.pendingRequests = new Map();

    this.localDevices = {};
    this.remoteDevices = new Set();

    this.scenesData = null; // Store scenes data locally

    this.name = "roborock";
    this.deviceNotify = null;
    this.serviceAreaRoomMapRefreshAttempts = new Map();
    this.matterUnsupportedSettingCommands = new Set();
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
        const persistPath = this.getPersistPath(id);
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        fs.writeFileSync(persistPath, JSON.stringify(state, null, 2, "utf8"));
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
          fs.writeFileSync(
            fallbackPath,
            JSON.stringify(state, null, 2, "utf8")
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
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(persistPath, JSON.stringify(state, null, 2, "utf8"));
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
    if (this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION) {
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
    for (const [key, entryValue] of entries.slice(0, 30)) {
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
    this.log.info(
      `Starting adapter. This might take a few minutes depending on your setup. Please wait.`
    );
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

    const userdata = await this.getUserData(this.loginApi);
    if (!userdata) {
      this.log.error(
        "Login failed or requires 2FA. Please complete authentication in the Config UI."
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
      return;
    }

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

          const scene = await this.api.get(`user/scene/home/${homeId}`);

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

          if (this.isCloudOnlyModeEnabled()) {
            this.log.info(
              "Roborock cloud-only mode is enabled; local LAN discovery and TCP connections will be skipped."
            );

            for (const device of managedDevicesForDiagnostics) {
              await this.updateTransportDiagnostics(device.duid, {
                lastTransport: "cloud",
                lastTransportReason: "cloud-only-mode",
                localIp: null,
                localDiscoveryState: "disabled",
                tcpConnectionState: "disabled",
              });
            }
          } else {
            for (const device of managedDevicesForDiagnostics) {
              if (!device.localKey) {
                await this.updateTransportDiagnostics(device.duid, {
                  lastTransport: "cloud",
                  lastTransportReason: "missing-local-key",
                });
              }
            }
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
          await this.updateHomeData(homeId);

          const discoveredDevices = this.isCloudOnlyModeEnabled()
            ? {}
            : await this.localConnector.getLocalDevices();

          await this.createDevices();
          await this.getNetworkInfo();

          if (!this.isCloudOnlyModeEnabled()) {
            // merge udp discovered devices with local devices found via mqtt
            Object.entries(discoveredDevices).forEach(([duid, ip]) => {
              if (
                !Object.prototype.hasOwnProperty.call(this.localDevices, duid)
              ) {
                this.localDevices[duid] = ip;
              }
            });
            this.log.debug(
              `localDevices: ${JSON.stringify(this.localDevices)}`
            );

            for (const device of localKeyDevices) {
              if (
                !Object.prototype.hasOwnProperty.call(
                  this.localDevices,
                  device.duid
                )
              ) {
                await this.updateTransportDiagnostics(device.duid, {
                  localDiscoveryState: "not-discovered",
                  lastTransportReason: "missing-local-ip",
                });
              }
            }

            for (const device in this.localDevices) {
              const duid = device;
              const ip = this.localDevices[device];

              await this.updateTransportDiagnostics(duid, {
                localIp: ip,
                localDiscoveryState: "discovered",
              });
              await this.localConnector.createClient(duid, ip);
            }
          }

          await this.initializeDeviceUpdates();
          this.bInited = true;
          this.log.info(`Starting adapter finished. Lets go!!!!!!!`);
        } else {
          this.log.info(
            `Most likely failed to login. Deleting UserData to force new login!`
          );
          await this.deleteStateAsync(`UserData`);
        }
      }
    } catch (error) {
      this.log.error("Failed to get home details: " + error.stack);
    }

    if (callback) {
      callback();
    }
  }

  async stopService() {
    try {
      await this.clearTimersAndIntervals();
      this.bInited = false;
    } catch (e) {
      this.catchError(e.stack);
    }
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
    for (const device of this.devices) {
      const duid = device.duid;
      if (!this.hasInitializedVacuum(duid)) {
        continue;
      }

      await this.vacuums[duid].getParameter(duid, "get_network_info");
    }
  }

  async createDevices() {
    const devices = this.devices;
    this.initializedVacuumDuids.clear();

    for (const device of devices) {
      const duid = device.duid;
      const name = device.name;

      this.log.debug(`Creating device: ${name} with duid: ${duid}`);

      // B01/Q7 robots are cloud/MQTT-only: mark them remote up front so the
      // transport layer never attempts local TCP connections to them.
      if (b01Q7Adapter.isB01Protocol(device.pv)) {
        this.remoteDevices.add(duid);
      }

      const robotModel = this.getProductAttribute(duid, "model");

      // model must start with "roborock.vacuum."
      if (!this.isSupportedVacuumModel(robotModel)) {
        this.log.warn(
          `Unsupported vacuum model '${robotModel || "unknown"}' for device ${duid}; skipping initialization.`
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

    // Start AFTER the loop: the loop's device gate reads
    // initializedVacuumDuids, which is only fully populated at this point.
    // (Calling it per-device made the start depend on device ordering.)
    this.startB01StatusLoop();
  }

  async initializeDeviceUpdates() {
    this.log.debug(`initializeDeviceUpdates`);

    const devices = this.devices;

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
        // 1-second tick would only burn cycles hitting the attempt throttle.
        if (
          this.getVacuumDeviceInfo(duid, "pv") ===
          b01Q7Adapter.B01_PROTOCOL_VERSION
        ) {
          return null;
        }
        this.clearInterval(this.vacuums[duid].getStatusIntervalHandle);
        this.vacuums[duid].getStatusIntervalHandle = this.setInterval(
          this.getStatus.bind(this),
          1000,
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

      await this.updateDataMinimumData(duid, this.vacuums[duid], robotModel);
    }
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

  /**
   * Get the home ID from the login API
   * @returns {Promise<string>} The home ID
   */
  async getHomeID() {
    if (!this.loginApi) {
      throw new Error("loginApi is not initialized. Call init() first.");
    }

    try {
      const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
      if (homeDetail && homeDetail.data && homeDetail.data.data) {
        return homeDetail.data.data.rrHomeId;
      }
      throw new Error("Failed to get home ID from homeDetail response");
    } catch (error) {
      this.log.error(`Failed to get home ID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get scenes from the Roborock API
   * @returns {Promise<Object>} The scenes data
   */

  /**
   * Get scenes for a specific device by duid
   * @param {string} duid - The device unique identifier
   * @returns {Array} Array of scenes for the specified device
   */

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
    if (this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION) {
      return {
        // Q7 robots mop with a manually filled tank: expose the mop/vacuum
        // mode switch, but never water-level status or control.
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
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

  async applyMatterCleanModeSettings(duid, settings, options = {}) {
    const { commandOptions } = this.buildCommandOptions(options, {
      requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
    });

    // Q7/B01: the robot has a native clean-type concept (vacuum / mop /
    // vacuum+mop via the `mode` property), so apply the Matter selection
    // directly. The v1-style workarounds (fan power OFF to fake mop-only,
    // water box modes) do not apply — Q7 water is a manual tank.
    if (
      this.getVacuumDeviceInfo(duid, "pv") === b01Q7Adapter.B01_PROTOCOL_VERSION
    ) {
      if (Number.isInteger(settings?.cleanMode)) {
        try {
          await this.startCommand(
            duid,
            "set_clean_type",
            [settings.cleanMode],
            commandOptions
          );
        } catch (error) {
          this.log.debug(
            `B01 clean-type command failed for ${duid}; continuing with the start command. ${error.message || error}`
          );
        }
      }

      const fanPower = settings?.fanPower;
      if (Number.isInteger(fanPower) && fanPower !== 105) {
        try {
          await this.startCommand(
            duid,
            "set_custom_mode",
            [fanPower],
            commandOptions
          );
        } catch (error) {
          this.log.debug(
            `B01 suction command failed for ${duid}; continuing with the start command. ${error.message || error}`
          );
        }
      }

      return;
    }

    if (
      Number.isInteger(settings?.fanPower) &&
      this.getMatterCleanModeCapabilities(duid).canControlFanPower
    ) {
      try {
        await this.runMatterSettingCommand(
          duid,
          "set_custom_mode",
          settings.fanPower,
          commandOptions
        );
      } catch (error) {
        this.rememberUnsupportedMatterSettingCommand(
          duid,
          "set_custom_mode",
          error
        );
        if (this.isMatterSettingTimeoutError(error)) {
          this.log.debug(
            `Matter clean mode fan command timed out for ${duid}; skipping remaining clean-mode prep and continuing with start command. ${error.message || error}`
          );
          return;
        }
        this.log.debug(
          `Matter clean mode fan command failed for ${duid}; continuing with start command. ${error.message || error}`
        );
      }
    }

    if (!Number.isInteger(settings?.waterBoxMode)) {
      return;
    }

    const waterCommands = this.getMatterWaterModeCommandCandidates(duid);
    if (waterCommands.length === 0) {
      this.log.debug(
        `Matter clean mode requested water mode ${settings.waterBoxMode} for ${duid}, but no supported Roborock water command was detected.`
      );
      return;
    }

    try {
      await this.runFirstMatterSettingCommand(
        duid,
        waterCommands,
        settings.waterBoxMode,
        commandOptions
      );
    } catch (error) {
      this.log.debug(
        `Matter clean mode water commands failed for ${duid}; continuing with start command. ${error.message || error}`
      );
    }
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

  async runFirstMatterSettingCommand(duid, commands, value, options = {}) {
    let lastError = null;

    for (const command of commands) {
      try {
        await this.runMatterSettingCommand(duid, command, value, options);
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
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    const vacuum = this.vacuums[duid];
    if (!vacuum || typeof vacuum.command != "function") {
      throw new Error(`Vacuum ${duid} is not initialized.`);
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

  isMatterSettingTimeoutError(error) {
    const message = `${error?.message || error || ""}`.toLowerCase();
    return message.includes("request") && message.includes("timed out after");
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

  decodeSniffedMessage(data, devices) {
    const dataString = JSON.stringify(data);

    const duidMatch = dataString.match(/\/(\w+)\.\w{3}'/);
    if (duidMatch) {
      const duidSniffed = duidMatch[1];

      const device = devices.find((device) => device.duid === duidSniffed);
      if (device) {
        const localKey = device.localKey;

        const payloadMatch = dataString.match(/'([a-fA-F0-9]+)'/);
        if (payloadMatch) {
          const hexPayload = payloadMatch[1];
          const msg = Buffer.from(hexPayload, "hex");

          const decodedMessage = this.message._decodeMsg(msg, localKey);
          this.log.debug(
            `Decoded sniffing message: ${JSON.stringify(JSON.parse(decodedMessage.payload))}`
          );
        }
      }
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
            : "marked-remote-after-connect-failure",
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

  async getConnector(duid) {
    const isRemote = await this.isRemoteDevice(duid);

    if (isRemote) {
      return this.rr_mqtt_connector;
    } else {
      return this.localConnector;
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
      const refreshedServiceAreaRooms =
        await this.refreshMatterServiceAreaRoomMappings(duid, vacuum);

      if (!refreshedServiceAreaRooms) {
        await vacuum.getParameter(duid, "get_room_mapping");
      }

      await vacuum.getParameter(duid, "get_consumable");

      await vacuum.getParameter(duid, "get_server_timer");

      await vacuum.getParameter(duid, "get_timer");

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
          await vacuum.getParameter(duid, "get_carpet_mode");
          break;
        case "roborock.vacuum.a27":
          await vacuum.getParameter(duid, "get_dust_collection_switch_status");
          await vacuum.getParameter(duid, "get_wash_towel_mode");
          await vacuum.getParameter(duid, "get_smart_wash_params");
          await vacuum.getParameter(duid, "app_get_dryer_setting");
          break;
        default:
          await vacuum.getParameter(duid, "get_carpet_mode");
          await vacuum.getParameter(duid, "get_carpet_clean_mode");
          await vacuum.getParameter(duid, "get_water_box_custom_mode");
      }
    } else {
      this.log.warn(
        `Unsupported model '${robotModel || "unknown"}'. Skipping minimum data update for ${duid}.`
      );
    }
  }

  async updateDataExtraData(duid, vacuum) {
    try {
      await vacuum.getParameter(duid, "get_fw_features");
      await vacuum.getParameter(duid, "get_multi_maps_list");
    } catch (error) {
      this.log.error(
        `Failed to get extra data for ${vacuum}: ${error.message}`
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
              `Loading Roborock map '${map.name}' for ${duid} to cache Matter Service Area rooms.`
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
            `Roborock map '${map.name}' for ${duid} did not return room mappings. It will appear in Matter once Roborock reports room segment IDs for that saved map.`
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
      `Restoring Roborock map '${originalMap?.name || originalMapId}' for ${duid} after caching Matter Service Area rooms.`
    );

    try {
      await vacuum.command(duid, "load_multi_map", originalMapId, {
        throwOnError: true,
      });
    } catch (error) {
      this.log.warn(
        `Failed to restore Roborock map '${originalMap?.name || originalMapId}' for ${duid} after caching Matter Service Area rooms: ${error.message || error}. The robot may stay on another saved map until the next refresh.`
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
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    // Matter/HomeKit controllers can send commands immediately after a bridge
    // restart, before Roborock login and createDevices() have populated
    // this.vacuums. Fail with a classifiable error instead of a raw TypeError
    // so callers can log a clear "still starting up" message and recover.
    if (!this.vacuums[duid]) {
      const notReadyError = new Error(
        `Roborock device ${duid} is not initialized yet; the plugin is still starting up or the device is missing from the account.`
      );
      notReadyError.code = "ROBOROCK_DEVICE_NOT_READY";
      if (options.waitForResult || options.throwOnError) {
        throw notReadyError;
      }

      this.log.warn(notReadyError.message);
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

  async setupBasicObjects() {
    await this.setObjectAsync("Devices", {
      type: "folder",
      common: {
        name: "Devices",
      },
      native: {},
    });

    await this.setObjectAsync("UserData", {
      type: "state",
      common: {
        name: "UserData string",
        type: "string",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    await this.setObjectAsync("HomeData", {
      type: "state",
      common: {
        name: "HomeData string",
        type: "string",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    await this.setObjectAsync("clientID", {
      type: "state",
      common: {
        name: "Client ID",
        type: "string",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });
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

      const transientErrorKind = this.getTransientErrorKind(errorText);
      // Some callers only pass a message (no attribute/duid). Do not render
      // "Failed to execute undefined on robot undefined (unknown model)" for
      // those; log the message as-is instead.
      const hasContext = attribute !== undefined || duid !== undefined;
      const message = hasContext
        ? `Failed to execute ${attribute} on robot ${duid} (${model || "unknown model"}): ${error}`
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
            ? `Failed to execute ${attribute} on robot ${duid} (${model || "unknown model"}): ${error.stack || error}`
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

  async getServerTimers(duid) {
    if (!this.vacuums[duid]) {
      throw new Error(`Vacuum ${duid} is not initialized.`);
    }

    return await this.vacuums[duid].getServerTimers(duid);
  }

  async updateServerTimer(duid, timerId, enabled) {
    if (!this.vacuums[duid]) {
      throw new Error(`Vacuum ${duid} is not initialized.`);
    }

    return await this.vacuums[duid].updateServerTimer(duid, timerId, enabled);
  }

  async getStatus(duid, options = {}) {
    try {
      if (!this.vacuums[duid]) {
        this.log.debug(
          `Skipping status refresh for ${duid}; the Roborock device runtime is not initialized yet.`
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

  async refreshB01Status(duid, options = {}) {
    // Q7/B01 status snapshot via prop.get, mapped to v1-shaped fields and
    // dispatched on the existing live-message path so the Matter accessory
    // updates exactly like it does for classic robots.
    //
    // The 1-second poll tick relies on getParameter's internal throttling for
    // classic robots; this path must throttle itself or every tick becomes a
    // cloud request. Periodic refreshes run at most every 45s, forced
    // refreshes (post-command, robot pushes) at most every 1.5s, and
    // concurrent callers share one in-flight request.
    if (!this._b01StatusState) {
      this._b01StatusState = new Map();
    }
    let refreshState = this._b01StatusState.get(duid);
    if (!refreshState) {
      refreshState = { lastAttemptAt: 0, inflight: null, consecutiveFailures: 0 };
      this._b01StatusState.set(duid, refreshState);
    }

    if (refreshState.inflight) {
      return refreshState.inflight;
    }

    // Throttle on ATTEMPTS, not successes: a robot or cloud that stops
    // answering must not turn the 1-second poll tick into a retry storm.
    const minimumGapMs = options.force ? 1500 : 45000;
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
        const v1Status = b01Q7Adapter.mapStatusToV1(data);

        if (refreshState.consecutiveFailures > 0) {
          this.log.info(
            `B01 status for ${duid} recovered after ${refreshState.consecutiveFailures} failed attempt(s).`
          );
        }
        refreshState.consecutiveFailures = 0;

        if (!refreshState.firstSuccessLogged) {
          refreshState.firstSuccessLogged = true;
          this.log.info(
            `B01 status online for ${duid}: state=${v1Status.state}, battery=${v1Status.battery ?? "?"}%, charging=${v1Status.charge_status === 1 ? "yes" : "no"}.`
          );
        }

        this.log.debug(
          `B01 status for ${duid}: ${JSON.stringify(data)} -> ${JSON.stringify(v1Status)}`
        );

        if (this.deviceNotify !== undefined) {
          this.deviceNotify("CloudMessage", { duid, payload: [v1Status] });
        }

        return v1Status;
      } catch (error) {
        refreshState.consecutiveFailures += 1;
        const message = error?.message || String(error);
        if (refreshState.consecutiveFailures % 10 === 0) {
          this.log.warn(
            `B01 status has failed ${refreshState.consecutiveFailures} times in a row for ${duid}. Last error: ${message}`
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
      "Starting the dedicated B01/Q7 status loop (15s tick, ~45s effective cloud cadence)."
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
    pollAllB01({ force: true });
    this.b01StatusLoopHandle = this.setInterval(pollAllB01, 15000);
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
    await this.setStateAsync("B01Rooms", { val: JSON.stringify(all), ack: true });
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
      `B01 rooms for ${duid}: ${rooms.length ? rooms.map((room) => `${room.roomName || "?"} (${room.roomId})`).join(", ") : "none reported"}.`
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
      throw new Error(`Failed to build B01 map request for ${duid}.`);
    }

    let entry;
    const promise = new Promise((resolve, reject) => {
      const timeout = this.setTimeout(() => {
        this.pendingB01MapRequests.delete(duid);
        reject(new Error(`B01 map request timed out after 20s for ${duid}.`));
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
      const translated =
        b01Q7Adapter.translateQ7WorkStatusToV1State(rawStatus);
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

module.exports = { Roborock };

////////////////////////////////////////////////////////////////////////////////////////////////////
