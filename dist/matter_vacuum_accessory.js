"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_timers_1 = require("node:timers");
const live_message_1 = require("./live_message");
const MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS = 2000;
const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = 2500;
function scheduleTimer(callback, delayMs) {
    const setTimer = typeof globalThis.setTimeout === "function"
        ? globalThis.setTimeout
        : node_timers_1.setTimeout;
    return setTimer(callback, delayMs);
}
function unrefTimer(timer) {
    if (typeof timer === "object" && typeof timer.unref === "function") {
        timer.unref();
    }
}
function clearTimer(timer) {
    const clear = typeof globalThis.clearTimeout === "function"
        ? globalThis.clearTimeout
        : node_timers_1.clearTimeout;
    clear(timer);
}
const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
// Live status entries older than this fall back to the HomeData snapshot.
const LIVE_STATUS_STALENESS_MS = 15 * 60 * 1000;
const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;
const RVC_RUN_MODE_TAG_IDLE = 16384;
const RVC_RUN_MODE_TAG_CLEANING = 16385;
const RVC_CLEAN_MODE_TAG_VACUUM = 16385;
const RVC_CLEAN_MODE_TAG_MOP = 16386;
const ROBOROCK_FAN_POWER_OFF = 105;
const ROBOROCK_FAN_POWER_BALANCED = 102;
const ROBOROCK_WATER_BOX_OFF = 200;
const ROBOROCK_WATER_BOX_MILD = 201;
// Matter Service Area OperationalStatusEnum (progress list entries).
const SERVICE_AREA_PROGRESS = {
    PENDING: 0,
    OPERATING: 1,
    SKIPPED: 2,
    COMPLETED: 3,
};
const RVC_OPERATIONAL_STATE = {
    STOPPED: 0,
    RUNNING: 1,
    PAUSED: 2,
    ERROR: 3,
    SEEKING_CHARGER: 64,
    CHARGING: 65,
    DOCKED: 66,
    EMPTYING_DUST_BIN: 67,
    CLEANING_MOP: 68,
    UPDATING_MAPS: 70,
};
const RVC_OPERATIONAL_STATE_LIST = [
    RVC_OPERATIONAL_STATE.STOPPED,
    RVC_OPERATIONAL_STATE.RUNNING,
    RVC_OPERATIONAL_STATE.PAUSED,
    RVC_OPERATIONAL_STATE.ERROR,
    RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
];
// The basic (non-extended) operational state list is the first four entries
// of the full list, without SEEKING_CHARGER.
const RVC_BASIC_OPERATIONAL_STATE_LIST = RVC_OPERATIONAL_STATE_LIST.slice(0, 4);
// Optional charging/docked additions. CHARGING (0x41) and DOCKED (0x42) are
// standard RVC operational state IDs (not manufacturer-range), so they are
// safe to advertise; newer Apple Home versions render them as "Charging" /
// "Docked" on the tile instead of "Ready".
const RVC_CHARGING_DOCKED_STATE_LIST = [
    RVC_OPERATIONAL_STATE.CHARGING,
    RVC_OPERATIONAL_STATE.DOCKED,
];
const POWER_SOURCE_STATUS = {
    ACTIVE: 1,
    UNAVAILABLE: 3,
};
const BATTERY_CHARGE_LEVEL = {
    OK: 0,
    WARNING: 1,
    CRITICAL: 2,
};
const BATTERY_CHARGE_STATE = {
    UNKNOWN: 0,
    IS_CHARGING: 1,
    IS_AT_FULL_CHARGE: 2,
    IS_NOT_CHARGING: 3,
};
const BATTERY_REPLACEABILITY = {
    UNSPECIFIED: 0,
};
const BATTERY_ESTIMATED_CHARGE_SECONDS_PER_PERCENT = 180;
const SERVICE_AREA_SELECT_STATUS = {
    SUCCESS: 0,
    UNSUPPORTED_AREA: 1,
    INVALID_IN_MODE: 2,
    INVALID_SET: 3,
};
const MATTER_LOCATION_NAME_MAX_LENGTH = 64;
const MATTER_MAP_NAME_MAX_LENGTH = 64;
const MATTER_AREA_ID_MAP_MULTIPLIER = 1000000;
const MATTER_AREA_ID_MAX = 0xffffffff;
const OPTIMISTIC_STATE_TTL_MS = 2 * 60 * 1000;
// Number of consecutive contradicting live Roborock states to tolerate before
// abandoning an optimistic state, so a command the robot acknowledged but did
// not act on cannot keep Apple Home on a wrong state until the TTL expires.
const OPTIMISTIC_CONTRADICTION_LIMIT = 2;
// Window after a Matter start/resume/area-clean command during which a follow-up
// pause or dock is forwarded to the robot even if the cached state still reads
// docked/charging. Models that fall back to cloud (e.g. S8 / roborock.vacuum.a51)
// can take tens of seconds to report Cleaning, and the optimistic state may clear
// first; without this window the plugin would silently drop a real user command.
const RECENT_CLEANING_COMMAND_WINDOW_MS = 60 * 1000;
const SLOW_MATTER_COMMAND_MS = 3000;
const MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS = [2000, 15000];
const MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS = [
    0, 2000, 5000, 10000, 20000, 30000,
];
const MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS = [
    2000, 15000, 30000, 60000, 90000, 120000, 150000, 180000,
];
const MATTER_RETURN_TO_DOCK_RETRY_DELAY_MS = 7000;
// Slow hosts (Raspberry Pi class hardware, busy child-bridge restarts) can
// keep the Homebridge Matter endpoint initializing well past 14 seconds, so
// back off further before giving up and waiting for the next live update.
const MATTER_INITIALIZATION_RETRY_DELAYS_MS = [
    1000, 3000, 10000, 30000, 60000,
];
const ROOM_CLEAN_STATE = 18;
const PAUSED_STATE = 10;
// Low-frequency safety net. Every publish is a full coherent snapshot and
// matter.js suppresses no-op writes, so this generates no Matter traffic
// unless the store actually drifted from the latest Roborock state.
const MATTER_STATE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
/**
 * Optional Homebridge 2 Matter exposure for Apple Home's native vacuum UI.
 *
 * This intentionally uses runtime `any` access instead of importing Homebridge
 * Matter types so the plugin still compiles and runs on Homebridge 1.x.
 */
class RoborockMatterVacuumAccessory {
    constructor(platform, accessory, device, isRegistered = false) {
        this.platform = platform;
        this.accessory = accessory;
        this.optimisticClusters = null;
        this.optimisticExpiresAt = 0;
        this.optimisticGeneration = 0;
        this.optimisticAction = null;
        this.contradictingLiveStateCount = 0;
        this.lastCleaningCommandAt = 0;
        this.selectedServiceAreaIds = [];
        this.roomCleaningAreaConfirmed = false;
        this.lastServiceAreaSummary = "";
        this.liveStatusUpdatedAt = 0;
        this.initialPublishLogged = false;
        this.lastLoggedBatteryHalfPercent = null;
        this.powerSourceResyncDone = false;
        this.serviceAreaCurrentArea = null;
        this.serviceAreaProgress = [];
        this.selectedCleanMode = CLEAN_MODE_VACUUM;
        this.selectedCleanModeNeedsApply = false;
        this.lastVacuumFanPower = null;
        this.lastWaterBoxMode = null;
        this.matterInitializationRetryAttempt = 0;
        this.matterInitializationRetryPending = false;
        this.returnToDockRetryPending = false;
        this.matterStateHeartbeatTimer = null;
        // Serializes every Matter publish so concurrent publishers (live messages,
        // refreshes, command paths) cannot land out of order. Homebridge defers each
        // updateAccessoryState via setImmediate, so without this chain an older
        // snapshot can overwrite a newer one and leave Apple Home on stale state.
        this.matterPublishChain = Promise.resolve();
        // Freshest status values seen from live Roborock messages. Preferred over the
        // slower HomeData snapshot when rebuilding clusters so registration snapshots
        // and attribute reads do not lag behind the latest push.
        this.liveStatus = new Map();
        this.registered = isRegistered;
        this.updateMetadata(device);
    }
    get api() {
        return this.platform.roborockAPI;
    }
    getMatterCommandOptions() {
        const options = {
            waitForResult: true,
            throwOnError: true,
            preferLocal: true,
            allowOfflineCloudSend: true,
        };
        if (this.platform.platformConfig.preferCloudForMatterCommands) {
            options.preferCloud = true;
            delete options.preferLocal;
        }
        return options;
    }
    getMatterMapLoadCommandOptions() {
        const options = {
            ...this.getMatterCommandOptions(),
            // Some older Roborock models apply load_multi_map but never complete the
            // local pending request. The cloud path gives Matter room cleaning a
            // reliable acknowledgement without forcing all Matter commands to cloud.
            preferCloud: true,
        };
        delete options.preferLocal;
        return options;
    }
    getMatterCleanModePrepCommandOptions() {
        return {
            ...this.getMatterCommandOptions(),
            requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
        };
    }
    markRegistered() {
        this.registered = true;
    }
    /**
     * Stops all background work for this accessory. Called on Homebridge
     * shutdown and when the accessory is unregistered, so no timer fires into a
     * torn-down bridge and no publish races a restarting child bridge.
     */
    dispose() {
        this.registered = false;
        if (this.matterStateHeartbeatTimer) {
            clearTimer(this.matterStateHeartbeatTimer);
            this.matterStateHeartbeatTimer = null;
        }
        this.clearOptimisticState();
    }
    scheduleMatterStateRefresh(reason, delayMs = 0) {
        if (!this.registered) {
            return;
        }
        const timer = scheduleTimer(() => {
            void this.updateMatterStateFromRoborock().catch((error) => {
                this.platform.log.warn(`Unable to refresh Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, delayMs);
        unrefTimer(timer);
    }
    updateMetadata(device) {
        const duid = device.duid;
        const displayName = this.api.getVacuumDeviceInfo(duid, "name") ||
            device.name ||
            "Roborock Vacuum";
        this.accessory.displayName = displayName;
        // Some Matter layers label the node from `name` rather than `displayName`;
        // set both so Apple Home is less likely to show a generic name.
        this.accessory.name = displayName;
        this.accessory.manufacturer = "Roborock";
        this.accessory.model =
            this.api.getProductAttribute(duid, "model") ||
                this.api.getVacuumDeviceInfo(duid, "model") ||
                "Roborock Vacuum";
        this.accessory.serialNumber =
            this.api.getVacuumDeviceInfo(duid, "sn") || duid;
        const firmwareRevision = this.api.getVacuumDeviceInfo(duid, "fv");
        if (firmwareRevision) {
            this.accessory.firmwareRevision = firmwareRevision;
        }
        else {
            delete this.accessory.firmwareRevision;
        }
        this.accessory.context = { ...(this.accessory.context || {}), duid };
        this.accessory.clusters = this.buildClusters();
        this.accessory.handlers = this.buildHandlers();
        this.accessory.getState = async (cluster, attribute) => {
            const clusterState = this.buildCluster(cluster);
            return clusterState ? clusterState[attribute] : undefined;
        };
    }
    async notifyDeviceUpdater(id, data) {
        if (id === "HomeData" || id === "RoomMapping") {
            if (id === "HomeData") {
                this.rememberHomeDataStatus(data);
            }
            await this.updateMatterStateFromRoborock();
            return;
        }
        if (id === "CloudMessage" || id === "LocalMessage") {
            const liveData = this.getLiveMessageForThisAccessory(data);
            if (liveData === null) {
                return;
            }
            await this.updateMatterStateFromMessage(liveData);
        }
    }
    async updateMatterStateFromRoborock() {
        var _a, _b, _c;
        if (!this.registered) {
            return;
        }
        const matter = this.platform.getMatterApi();
        if (!matter || typeof matter.updateAccessoryState !== "function") {
            return;
        }
        const clusters = this.buildClusters();
        const updated = await this.publishRoborockSnapshot(clusters, "Roborock state refresh");
        if (updated) {
            const power = clusters.powerSource;
            const halfPercent = power === null || power === void 0 ? void 0 : power.batPercentRemaining;
            const batteryChanged = typeof halfPercent === "number" &&
                halfPercent !== this.lastLoggedBatteryHalfPercent;
            if (!this.initialPublishLogged || batteryChanged) {
                this.initialPublishLogged = true;
                if (typeof halfPercent === "number") {
                    this.lastLoggedBatteryHalfPercent = halfPercent;
                }
                const opState = clusters.rvcOperationalState;
                this.platform.log.info(`Matter publish for ${(_b = (_a = this.accessory.context) === null || _a === void 0 ? void 0 : _a.duid) !== null && _b !== void 0 ? _b : this.accessory.UUID}: battery=${typeof halfPercent === "number" ? halfPercent / 2 + "%" : "n/a"}, operationalState=${(_c = opState === null || opState === void 0 ? void 0 : opState.operationalState) !== null && _c !== void 0 ? _c : "n/a"}.`);
            }
            this.ensureMatterStateHeartbeat();
        }
    }
    buildHandlers() {
        const handlers = {
            identify: {
                identify: async () => {
                    await this.identifyVacuum();
                },
            },
            rvcRunMode: {
                changeToMode: async (request) => {
                    await this.changeRunMode(request === null || request === void 0 ? void 0 : request.newMode);
                },
            },
            rvcOperationalState: {
                pause: async () => {
                    await this.pauseCleaning();
                },
                resume: async () => {
                    await this.resumeCleaning();
                },
                goHome: async () => {
                    await this.returnToDock();
                },
            },
        };
        if (this.isCleanModeEnabled()) {
            handlers.rvcCleanMode = {
                changeToMode: async (request) => {
                    await this.changeCleanMode(request === null || request === void 0 ? void 0 : request.newMode);
                },
            };
        }
        if (this.isServiceAreaEnabled()) {
            handlers.serviceArea = {
                selectAreas: async (request) => {
                    return await this.selectServiceAreas(request === null || request === void 0 ? void 0 : request.newAreas);
                },
            };
        }
        return handlers;
    }
    async identifyVacuum() {
        await this.publishCurrentMatterState("Matter identify command", {
            clearOptimistic: true,
        });
        const findMe = this.api.find_me;
        if (typeof findMe !== "function") {
            this.platform.log.debug(`Matter identify requested for ${this.getVacuumName()}, but the Roborock API does not expose find_me.`);
            return;
        }
        try {
            await findMe.call(this.api, this.getDuid(), this.getMatterCommandOptions());
        }
        catch (error) {
            this.platform.log.warn(`Unable to locate ${this.getVacuumName()} from Matter identify: ${this.getErrorMessage(error)}`);
        }
        await this.publishCurrentMatterState("Matter identify command complete", {
            clearOptimistic: true,
        });
    }
    async changeRunMode(newMode) {
        var _a;
        const name = this.getVacuumName();
        const duid = this.getDuid();
        this.platform.log.info(`Matter run mode request for ${name}: ${newMode !== null && newMode !== void 0 ? newMode : "unknown"}.`);
        if (newMode === RUN_MODE_CLEANING) {
            const selectedAreas = this.getSelectedServiceAreaSegments();
            if (selectedAreas.length > 0) {
                const selectedMapIds = this.getSelectedServiceAreaMapIds(selectedAreas);
                const targetMapId = (_a = selectedMapIds[0]) !== null && _a !== void 0 ? _a : null;
                // Roborock can only clean room segments from one map at a time. Service
                // area selection already constrains this to a single map, so this only
                // guards an unexpected multi-map selection by cleaning the first map
                // instead of throwing out of the Matter command handler.
                const areasToClean = selectedMapIds.length > 1
                    ? selectedAreas.filter((area) => area.mapId === targetMapId)
                    : selectedAreas;
                if (selectedMapIds.length > 1) {
                    this.platform.log.warn(`Matter requested room cleaning across multiple Roborock maps for ${name}; cleaning only the areas on map ${targetMapId}.`);
                }
                const selectedAreaNames = areasToClean.map((area) => this.formatServiceAreaName(area));
                this.platform.log.info(`Starting ${name} from Matter for selected service area(s): ${selectedAreaNames.join(", ")}.`);
                const state = {
                    rvcRunMode: { currentMode: RUN_MODE_CLEANING },
                    rvcOperationalState: {
                        operationalState: RVC_OPERATIONAL_STATE.RUNNING,
                    },
                };
                this.beginServiceAreaProgress(areasToClean.map((area) => area.areaId));
                this.setAndScheduleOptimisticState(state, "selected-area start");
                this.dispatchRoborockMatterCommand("service area clean", async () => {
                    await this.applySelectedCleanModeIfNeeded();
                    await this.loadMatterMapIfNeeded(duid, targetMapId);
                    await this.api.app_segment_clean_by_ids(duid, areasToClean.map((area) => area.segmentId), this.getMatterCommandOptions());
                });
                return;
            }
            this.platform.log.info(`Starting ${name} from Matter.`);
            const state = {
                rvcRunMode: { currentMode: RUN_MODE_CLEANING },
                rvcOperationalState: {
                    operationalState: RVC_OPERATIONAL_STATE.RUNNING,
                },
            };
            this.clearServiceAreaProgress();
            this.setAndScheduleOptimisticState(state, "start");
            this.dispatchRoborockMatterCommand("start", async () => {
                await this.applySelectedCleanModeIfNeeded();
                await this.api.app_start(duid, this.getMatterCommandOptions());
            });
            return;
        }
        if (newMode === RUN_MODE_IDLE) {
            this.platform.log.info(`Stopping ${name} from Matter. Use the Home/Dock action to dock intentionally.`);
            const state = {
                rvcRunMode: { currentMode: RUN_MODE_IDLE },
                rvcOperationalState: {
                    operationalState: RVC_OPERATIONAL_STATE.STOPPED,
                },
            };
            this.setAndScheduleOptimisticState(state, "stop");
            this.dispatchRoborockMatterCommand("stop", () => this.api.app_stop(duid, this.getMatterCommandOptions()));
            return;
        }
        this.platform.log.warn(`Ignoring unsupported Matter run mode '${newMode}' for ${name}.`);
    }
    async changeCleanMode(newMode) {
        const name = this.getVacuumName();
        this.platform.log.info(`Matter clean mode request for ${name}: ${newMode !== null && newMode !== void 0 ? newMode : "unknown"}.`);
        if (this.isSupportedCleanMode(newMode)) {
            this.rememberCurrentRoborockCleanModeSettings();
            this.selectedCleanMode = newMode;
            this.selectedCleanModeNeedsApply = true;
            const state = {
                rvcCleanMode: { currentMode: newMode },
            };
            this.setAndScheduleOptimisticState(state, "clean mode change");
            return;
        }
        this.platform.log.warn(`Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`);
    }
    async pauseCleaning() {
        const roborockState = this.getNumberStatus("state");
        const chargeStatus = this.getNumberStatus("charge_status");
        const currentOperationalState = this.getOperationalState(roborockState, chargeStatus);
        const looksIdle = this.isRoborockDockedOrCharging(roborockState, chargeStatus) ||
            (roborockState !== null &&
                !this.isInCleaningRunMode(currentOperationalState));
        // Always forward an explicit Matter pause to the robot. The cached snapshot
        // can lag or be overridden by a stale HomeData refresh while the robot is
        // really cleaning (issues #4 and #12), so hard-dropping the command based on
        // it silently failed real pauses. Pausing an already-stopped robot is a
        // harmless no-op, and the optimistic state self-corrects if it was idle.
        if (looksIdle) {
            this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter despite an idle snapshot; the cached state may be stale.`);
        }
        else {
            this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter.`);
        }
        const state = {
            rvcOperationalState: {
                operationalState: RVC_OPERATIONAL_STATE.PAUSED,
            },
        };
        this.setAndScheduleOptimisticState(state, "pause");
        this.dispatchRoborockMatterCommand("pause", () => this.api.app_pause(this.getDuid(), this.getMatterCommandOptions()));
    }
    async resumeCleaning() {
        this.platform.log.info(`Resuming ${this.getVacuumName()} from Matter.`);
        const state = {
            rvcRunMode: { currentMode: RUN_MODE_CLEANING },
            rvcOperationalState: {
                operationalState: RVC_OPERATIONAL_STATE.RUNNING,
            },
        };
        this.setAndScheduleOptimisticState(state, "resume");
        this.dispatchRoborockMatterCommand("resume", async () => {
            await this.applySelectedCleanModeIfNeeded();
            await this.api.app_start(this.getDuid(), this.getMatterCommandOptions());
        });
    }
    async returnToDock() {
        // Always forward an explicit Matter dock to the robot. As with pause, the
        // cached snapshot can lag or be overridden by a stale HomeData refresh while
        // the robot is really cleaning (issues #4 and #12); docking an already-docked
        // robot is a harmless no-op.
        if (this.isDockedOrChargingNow()) {
            this.platform.log.info(`Sending ${this.getVacuumName()} back to dock from Matter despite a docked snapshot; the cached state may be stale.`);
        }
        else {
            this.platform.log.info(`Sending ${this.getVacuumName()} back to dock from Matter.`);
        }
        const returnOperationalState = this.isExtendedOperationalStateEnabled()
            ? RVC_OPERATIONAL_STATE.SEEKING_CHARGER
            : RVC_OPERATIONAL_STATE.STOPPED;
        const state = {
            rvcRunMode: {
                currentMode: this.isInCleaningRunMode(returnOperationalState)
                    ? RUN_MODE_CLEANING
                    : RUN_MODE_IDLE,
            },
            rvcOperationalState: {
                operationalState: returnOperationalState,
            },
        };
        this.setAndScheduleOptimisticState(state, "return to dock");
        this.dispatchRoborockMatterCommand("return to dock", () => this.api.app_charge(this.getDuid(), this.getMatterCommandOptions()), { retryReturnToDockIfStillActive: true });
    }
    scheduleMatterStateUpdate(reason, optimisticGeneration) {
        if (!this.registered) {
            return;
        }
        const timer = scheduleTimer(() => {
            if (optimisticGeneration !== undefined &&
                optimisticGeneration !== this.optimisticGeneration) {
                this.platform.log.debug(`Skipping stale Matter optimistic state update after ${reason} for ${this.getVacuumName()}.`);
                return;
            }
            // Build the snapshot at execution time so it reflects the freshest
            // Roborock and optimistic state instead of a stale captured copy.
            void this.updateMatterState(this.buildClusters(), reason)
                .then((updated) => {
                if (updated) {
                    this.ensureMatterStateHeartbeat();
                }
            })
                .catch((error) => {
                this.platform.log.warn(`Unable to update Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, 0);
        unrefTimer(timer);
    }
    setAndScheduleOptimisticState(partialClusters, reason) {
        var _a;
        if (this.getNumberFromValue((_a = partialClusters.rvcOperationalState) === null || _a === void 0 ? void 0 : _a.operationalState) === RVC_OPERATIONAL_STATE.RUNNING) {
            // Remember when a start/resume/area-clean was issued so a follow-up pause
            // or dock is not dropped while the robot is still spinning up and the
            // cached snapshot lags behind (see RECENT_CLEANING_COMMAND_WINDOW_MS).
            this.lastCleaningCommandAt = Date.now();
        }
        const optimisticGeneration = this.setOptimisticState(partialClusters, reason);
        this.scheduleMatterStateUpdate(reason, optimisticGeneration);
    }
    hasRecentlyCommandedCleaning() {
        return (Date.now() - this.lastCleaningCommandAt <
            RECENT_CLEANING_COMMAND_WINDOW_MS);
    }
    async updateMatterState(partialClusters, reason = "state update") {
        if (!this.registered) {
            return false;
        }
        const matter = this.platform.getMatterApi();
        if (!matter || typeof matter.updateAccessoryState !== "function") {
            return false;
        }
        if (Object.keys(partialClusters).length === 0) {
            return false;
        }
        // Every publish is a full snapshot and writes are serialized in submission
        // order. matter.js suppresses no-op attribute writes at its store level, so
        // no plugin-side change tracking is needed; tracking published values here
        // previously allowed racing publishers to desynchronize the plugin from the
        // Matter store, leaving Apple Home stuck on stale state ("Updating...").
        // Per-cluster fault isolation: one misbehaving cluster (bad attribute
        // shape, transient matter.js error) must never block the others — a
        // frozen battery reading because the operational-state publish failed is
        // exactly the failure mode this prevents. Only a TOTAL failure is
        // rethrown, preserving the initialization-retry semantics below.
        const clusterEntries = Object.entries(partialClusters);
        const publishTask = this.matterPublishChain.then(async () => {
            const failures = [];
            await Promise.all(clusterEntries.map(async ([cluster, attributes]) => {
                try {
                    await matter.updateAccessoryState(this.accessory.UUID, cluster, attributes);
                }
                catch (error) {
                    failures.push(error);
                    this.platform.log.debug(`Matter publish for cluster ${cluster} on ${this.accessory.UUID} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }));
            if (failures.length > 0) {
                if (failures.length === clusterEntries.length) {
                    throw failures[0];
                }
                // Partial failure: the surviving clusters have landed (that is the
                // isolation), but an initializing endpoint should still get its
                // retry so the failed cluster receives its value too.
                const initFailure = failures.find((failure) => this.isMatterInitializingError(failure));
                if (initFailure) {
                    this.scheduleMatterInitializationRetry(reason, initFailure);
                }
            }
        });
        this.matterPublishChain = publishTask.then(() => undefined, () => undefined);
        try {
            await publishTask;
            this.matterInitializationRetryAttempt = 0;
            this.matterInitializationRetryPending = false;
            return true;
        }
        catch (error) {
            if (this.isMatterInitializingError(error)) {
                this.scheduleMatterInitializationRetry(reason, error);
                return false;
            }
            throw error;
        }
    }
    /**
     * Publish a full Roborock cluster snapshot, performing a one-time battery
     * resync per boot first. Matter controllers filter attribute reports by
     * cluster data version, and matter.js suppresses no-op writes — so a
     * battery that sits at the same value forever never generates a new report
     * for a controller whose cache missed one (observed in the field as Apple
     * Home stuck on a pairing-day percentage across server restarts).
     * Publishing the battery attributes as briefly unknown and then with their
     * real values forces two genuine store changes, bumping the data version
     * so every subscribed controller receives a fresh report — no hub restart
     * or re-pairing required.
     */
    async publishRoborockSnapshot(clusters, reason) {
        var _a, _b;
        const power = clusters.powerSource;
        const resyncEligible = !this.powerSourceResyncDone &&
            power !== undefined &&
            typeof power.batPercentRemaining === "number";
        if (resyncEligible) {
            await this.updateMatterState({
                powerSource: {
                    ...power,
                    batPercentRemaining: null,
                    batChargeState: 0,
                    batTimeToFullCharge: null,
                },
            }, "Battery resync nudge");
        }
        const updated = await this.updateMatterState(clusters, reason);
        if (updated && resyncEligible) {
            this.powerSourceResyncDone = true;
            this.platform.log.info(`Battery resync for ${(_b = (_a = this.accessory.context) === null || _a === void 0 ? void 0 : _a.duid) !== null && _b !== void 0 ? _b : this.accessory.UUID}: forced a fresh Matter attribute report (battery=${power.batPercentRemaining / 2}%).`);
        }
        return updated;
    }
    async updateMatterStateFromMessage(data) {
        if (!this.registered) {
            return;
        }
        const status = this.extractStatusUpdate(data);
        if (!status) {
            return;
        }
        const state = this.getNumberFromValue(status.state);
        const chargeStatus = this.getNumberFromValue(status.charge_status);
        const battery = this.getNumberFromValue(status.battery);
        const cleanArea = this.getNumberFromValue(status.clean_area);
        const cleanTime = this.getNumberFromValue(status.clean_time);
        if (state === null &&
            chargeStatus === null &&
            battery === null &&
            cleanArea === null &&
            cleanTime === null) {
            return;
        }
        // Remember the freshest live values so a later full cluster rebuild reflects
        // them instead of the slower HomeData snapshot.
        const previousState = this.getNumberStatus("state");
        if (state !== null &&
            state !== ROOM_CLEAN_STATE &&
            state !== PAUSED_STATE) {
            this.roomCleaningAreaConfirmed = false;
        }
        else if (state === ROOM_CLEAN_STATE &&
            previousState !== ROOM_CLEAN_STATE &&
            previousState !== PAUSED_STATE) {
            this.roomCleaningAreaConfirmed = false;
        }
        this.rememberLiveStatus("state", state);
        this.rememberLiveStatus("charge_status", chargeStatus);
        this.rememberLiveStatus("battery", battery);
        this.rememberLiveStatus("clean_area", cleanArea);
        this.rememberLiveStatus("clean_time", cleanTime);
        if ((state !== null && state !== void 0 ? state : previousState) === ROOM_CLEAN_STATE &&
            cleanArea !== null &&
            cleanTime !== null) {
            this.roomCleaningAreaConfirmed = cleanArea > 0 && cleanTime > 0;
        }
        if (state !== null || chargeStatus !== null) {
            // Confirm or contradict any pending optimistic state. While optimism is
            // active the snapshot below still publishes the optimistic values, so no
            // separate suppression of the live values is needed.
            this.reconcileOptimisticStateWithLive(this.getOperationalState(state, chargeStatus), state, chargeStatus);
        }
        if (state !== null) {
            this.completeServiceAreaProgressIfDone(this.getOperationalState(state, chargeStatus));
        }
        const updated = await this.publishRoborockSnapshot(this.buildClusters(), "live state");
        if (updated) {
            this.ensureMatterStateHeartbeat();
        }
    }
    buildClusters() {
        const clusters = {
            rvcRunMode: this.buildRunModeCluster(),
            rvcOperationalState: this.buildOperationalStateCluster(),
        };
        this.addCleanModeCluster(clusters);
        this.addPowerSourceCluster(clusters);
        if (this.isServiceAreaEnabled() && this.hasServiceAreasToExpose()) {
            // Publishing a Service Area cluster with an empty supportedAreas list
            // violates Matter conformance (the spec requires at least one area)
            // and makes Apple Home abort commissioning. Robots without room data
            // (e.g. B01/Q7 until the map channel lands) omit the cluster instead.
            clusters.serviceArea = this.buildServiceAreaCluster();
        }
        return this.applyOptimisticState(clusters);
    }
    buildCluster(cluster) {
        var _a;
        let clusterState;
        switch (cluster) {
            case "rvcRunMode":
                clusterState = this.buildRunModeCluster();
                break;
            case "rvcCleanMode":
                clusterState = this.isCleanModeEnabled()
                    ? this.buildCleanModeCluster()
                    : undefined;
                break;
            case "rvcOperationalState":
                clusterState = this.buildOperationalStateCluster();
                break;
            case "powerSource":
                clusterState = this.isPowerSourceEnabled()
                    ? this.buildPowerSourceCluster()
                    : undefined;
                break;
            case "serviceArea":
                clusterState =
                    this.isServiceAreaEnabled() && this.hasServiceAreasToExpose()
                        ? this.buildServiceAreaCluster()
                        : undefined;
                break;
            default:
                return undefined;
        }
        if (!clusterState) {
            return undefined;
        }
        const optimisticCluster = (_a = this.getActiveOptimisticState()) === null || _a === void 0 ? void 0 : _a[cluster];
        return optimisticCluster
            ? { ...clusterState, ...optimisticCluster }
            : clusterState;
    }
    buildRunModeCluster() {
        return {
            supportedModes: [
                {
                    label: "Idle",
                    mode: RUN_MODE_IDLE,
                    modeTags: [{ value: RVC_RUN_MODE_TAG_IDLE }],
                },
                {
                    label: "Cleaning",
                    mode: RUN_MODE_CLEANING,
                    modeTags: [{ value: RVC_RUN_MODE_TAG_CLEANING }],
                },
            ],
            currentMode: this.isInCleaningRunMode(this.getOperationalState())
                ? RUN_MODE_CLEANING
                : RUN_MODE_IDLE,
        };
    }
    buildCleanModeCluster() {
        return {
            supportedModes: this.getSupportedCleanModes(),
            currentMode: this.getCurrentCleanMode(),
        };
    }
    getSupportedCleanModes() {
        const supportedModes = [
            {
                label: "Vacuum",
                mode: CLEAN_MODE_VACUUM,
                modeTags: [{ value: RVC_CLEAN_MODE_TAG_VACUUM }],
            },
        ];
        if (this.getMatterCleanModeCapabilities().canMop) {
            supportedModes.push({
                label: "Mop",
                mode: CLEAN_MODE_MOP,
                modeTags: [{ value: RVC_CLEAN_MODE_TAG_MOP }],
            }, {
                // Matter has no dedicated "vacuum then mop" tag, so combine the two
                // standard RVC Clean Mode tags instead of an undefined tag value.
                label: "Vacuum + Mop",
                mode: CLEAN_MODE_VACUUM_AND_MOP,
                modeTags: [
                    { value: RVC_CLEAN_MODE_TAG_VACUUM },
                    { value: RVC_CLEAN_MODE_TAG_MOP },
                ],
            });
        }
        return supportedModes;
    }
    getCurrentCleanMode() {
        return this.isSupportedCleanMode(this.selectedCleanMode)
            ? this.selectedCleanMode
            : CLEAN_MODE_VACUUM;
    }
    isSupportedCleanMode(mode) {
        return this.getSupportedCleanModes().some((supportedMode) => supportedMode.mode === mode);
    }
    getMatterCleanModeCapabilities() {
        const getCapabilities = this.api.getMatterCleanModeCapabilities;
        if (typeof getCapabilities !== "function") {
            return { canVacuum: true, canMop: false };
        }
        // Guard against older/patched API builds returning undefined so cluster
        // builds (which run inside Matter attribute reads) can never throw.
        const capabilities = getCapabilities.call(this.api, this.getDuid());
        return capabilities !== null && capabilities !== void 0 ? capabilities : { canVacuum: true, canMop: false };
    }
    async applySelectedCleanModeIfNeeded() {
        if (!this.selectedCleanModeNeedsApply) {
            return;
        }
        const applySettings = this.api.applyMatterCleanModeSettings;
        if (typeof applySettings !== "function") {
            this.selectedCleanModeNeedsApply = false;
            return;
        }
        const settings = this.getRoborockCleanModeSettings(this.getCurrentCleanMode());
        if (!settings) {
            this.selectedCleanModeNeedsApply = false;
            return;
        }
        this.platform.log.info(`Applying ${this.getCleanModeLabel(this.getCurrentCleanMode())} mode to ${this.getVacuumName()} before starting.`);
        try {
            await this.withCleanModePrepTimeout(applySettings.call(this.api, this.getDuid(), settings, this.getMatterCleanModePrepCommandOptions()));
        }
        catch (error) {
            this.platform.log.warn(`Unable to apply ${this.getCleanModeLabel(this.getCurrentCleanMode())} mode to ${this.getVacuumName()} before starting; continuing with the start command. ${this.getErrorMessage(error)}`);
        }
        finally {
            this.selectedCleanModeNeedsApply = false;
        }
    }
    async withCleanModePrepTimeout(promise) {
        let timeout;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = scheduleTimer(() => {
                reject(new Error(`Matter clean mode prep timed out after ${MATTER_CLEAN_MODE_PREP_TIMEOUT_MS} ms.`));
            }, MATTER_CLEAN_MODE_PREP_TIMEOUT_MS);
            unrefTimer(timeout);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            if (timeout) {
                clearTimer(timeout);
            }
        }
    }
    getRoborockCleanModeSettings(cleanMode) {
        const capabilities = this.getMatterCleanModeCapabilities();
        // Always carry the selected Matter clean mode; protocol layers that have
        // a native clean-type concept (B01/Q7) apply it directly and ignore the
        // v1-style fan/water workarounds below.
        const settings = { cleanMode };
        if (capabilities.canControlFanPower) {
            settings.fanPower =
                cleanMode === CLEAN_MODE_MOP
                    ? ROBOROCK_FAN_POWER_OFF
                    : this.getPreferredVacuumFanPower();
        }
        if (capabilities.canControlWater) {
            settings.waterBoxMode =
                cleanMode === CLEAN_MODE_VACUUM
                    ? ROBOROCK_WATER_BOX_OFF
                    : this.getPreferredWaterBoxMode();
        }
        return Object.keys(settings).length > 0 ? settings : null;
    }
    rememberCurrentRoborockCleanModeSettings() {
        const fanPower = this.getNumberStatus("fan_power");
        if (fanPower !== null && fanPower !== ROBOROCK_FAN_POWER_OFF) {
            this.lastVacuumFanPower = fanPower;
        }
        const waterBoxMode = this.getWaterBoxModeStatus();
        if (waterBoxMode !== null && waterBoxMode !== ROBOROCK_WATER_BOX_OFF) {
            this.lastWaterBoxMode = waterBoxMode;
        }
    }
    getPreferredVacuumFanPower() {
        var _a;
        const currentFanPower = this.getNumberStatus("fan_power");
        if (currentFanPower !== null &&
            currentFanPower !== ROBOROCK_FAN_POWER_OFF) {
            this.lastVacuumFanPower = currentFanPower;
            return currentFanPower;
        }
        return (_a = this.lastVacuumFanPower) !== null && _a !== void 0 ? _a : ROBOROCK_FAN_POWER_BALANCED;
    }
    getWaterBoxModeStatus() {
        var _a;
        return ((_a = this.getNumberStatus("water_box_custom_mode")) !== null && _a !== void 0 ? _a : this.getNumberStatus("water_box_mode"));
    }
    getPreferredWaterBoxMode() {
        var _a;
        const currentWaterBoxMode = this.getWaterBoxModeStatus();
        if (currentWaterBoxMode !== null &&
            currentWaterBoxMode !== ROBOROCK_WATER_BOX_OFF) {
            this.lastWaterBoxMode = currentWaterBoxMode;
            return currentWaterBoxMode;
        }
        return (_a = this.lastWaterBoxMode) !== null && _a !== void 0 ? _a : ROBOROCK_WATER_BOX_MILD;
    }
    getCleanModeLabel(cleanMode) {
        switch (cleanMode) {
            case CLEAN_MODE_MOP:
                return "Mop";
            case CLEAN_MODE_VACUUM_AND_MOP:
                return "Vacuum + Mop";
            default:
                return "Vacuum";
        }
    }
    buildOperationalStateCluster() {
        const operationalState = this.getOperationalState();
        return {
            // RVC Operational State requires PhaseList and CurrentPhase to be null.
            phaseList: null,
            currentPhase: null,
            // Advertise operational state IDs without labels. Apple Home stops
            // commissioning ("Connecting" forever) when the list carries labels or
            // manufacturer-range IDs, so only bare IDs are exposed here.
            operationalStateList: this.getOperationalStateList().map((operationalStateId) => ({ operationalStateId })),
            operationalState,
        };
    }
    buildPowerSourceCluster(batteryValue, chargeStatusValue, stateValue) {
        const battery = batteryValue === undefined
            ? this.getNumberStatus("battery")
            : batteryValue;
        const chargeStatus = chargeStatusValue === undefined
            ? this.getNumberStatus("charge_status")
            : chargeStatusValue;
        const state = stateValue === undefined ? this.getNumberStatus("state") : stateValue;
        const normalizedBattery = battery === null ? null : Math.max(0, Math.min(100, battery));
        const batChargeState = this.getBatteryChargeState(normalizedBattery, chargeStatus, state);
        return {
            status: normalizedBattery === null
                ? POWER_SOURCE_STATUS.UNAVAILABLE
                : POWER_SOURCE_STATUS.ACTIVE,
            order: 0,
            description: "Roborock vacuum battery",
            batPresent: normalizedBattery !== null,
            batPercentRemaining: normalizedBattery === null ? null : normalizedBattery * 2,
            batChargeLevel: this.getBatteryChargeLevel(normalizedBattery),
            batChargeState,
            batReplacementNeeded: false,
            batReplaceability: BATTERY_REPLACEABILITY.UNSPECIFIED,
            batFunctionalWhileCharging: true,
            batTimeToFullCharge: this.getBatteryTimeToFullCharge(normalizedBattery, batChargeState),
            batChargingCurrent: null,
        };
    }
    addPowerSourceCluster(clusters, batteryValue, chargeStatusValue, stateValue) {
        if (!this.isPowerSourceEnabled()) {
            return;
        }
        clusters.powerSource = this.buildPowerSourceCluster(batteryValue, chargeStatusValue, stateValue);
    }
    addCleanModeCluster(clusters) {
        if (!this.isCleanModeEnabled()) {
            return;
        }
        clusters.rvcCleanMode = this.buildCleanModeCluster();
    }
    hasServiceAreasToExpose() {
        return this.getMatterServiceAreas().length > 0;
    }
    beginServiceAreaProgress(areaIds) {
        if (areaIds.length === 0) {
            this.clearServiceAreaProgress();
            return;
        }
        // We know which rooms were requested; the robot does not report which
        // one it is inside, so the first requested area is shown as operating
        // and the rest as pending until the run completes.
        this.serviceAreaCurrentArea = areaIds[0];
        this.serviceAreaProgress = areaIds.map((areaId, index) => ({
            areaId,
            status: index === 0
                ? SERVICE_AREA_PROGRESS.OPERATING
                : SERVICE_AREA_PROGRESS.PENDING,
        }));
    }
    clearServiceAreaProgress() {
        this.serviceAreaCurrentArea = null;
        this.serviceAreaProgress = [];
    }
    completeServiceAreaProgressIfDone(operationalState) {
        if (this.serviceAreaProgress.length === 0) {
            return;
        }
        if (this.isInCleaningRunMode(operationalState)) {
            return;
        }
        // The run ended (docked, charging, stopped): everything requested is
        // reported as completed and no area is current anymore.
        this.serviceAreaCurrentArea = null;
        this.serviceAreaProgress = this.serviceAreaProgress.map((entry) => ({
            areaId: entry.areaId,
            status: SERVICE_AREA_PROGRESS.COMPLETED,
        }));
    }
    buildServiceAreaCluster() {
        var _a;
        const areas = this.getMatterServiceAreas();
        const supportedMaps = this.getMatterServiceAreaMaps(areas);
        const includeMapNamesInAreaLabels = supportedMaps.length > 1;
        const supportedAreaIds = new Set(areas.map((area) => area.areaId));
        const selectedAreas = this.selectedServiceAreaIds.filter((areaId) => supportedAreaIds.has(areaId));
        if (selectedAreas.length !== this.selectedServiceAreaIds.length) {
            this.selectedServiceAreaIds = selectedAreas;
        }
        this.logMatterServiceAreaSummary(areas, supportedMaps);
        const state = {
            // Live cleaning progress. The attributes are ALWAYS present (empty
            // list / null when idle): Homebridge derives Matter cluster features
            // from which attributes are provided at registration (see homebridge
            // #3914 for the PowerSource equivalent), so omitting progress here
            // would leave the Service Area progress feature unannounced at
            // commissioning — controllers that render a progress pill (Apple
            // Home) then sit on a generic "Preparing"/"heading to the room"
            // label for the entire run.
            progress: this.serviceAreaProgress.map((entry) => ({ ...entry })),
            estimatedEndTime: null,
            supportedAreas: areas.map((area) => ({
                areaId: area.areaId,
                mapId: area.mapId,
                areaInfo: {
                    locationInfo: {
                        locationName: this.getMatterLocationDisplayName(area, includeMapNamesInAreaLabels),
                        floorNumber: null,
                        areaType: null,
                    },
                    landmarkInfo: null,
                },
            })),
            selectedAreas,
            currentArea: (_a = this.serviceAreaCurrentArea) !== null && _a !== void 0 ? _a : this.getCurrentServiceArea(selectedAreas),
        };
        if (supportedMaps.length > 0) {
            state.supportedMaps = supportedMaps;
        }
        return state;
    }
    getCurrentServiceArea(selectedAreas) {
        if (selectedAreas.length !== 1 || !this.roomCleaningAreaConfirmed) {
            return null;
        }
        const state = this.getNumberStatus("state");
        return state === ROOM_CLEAN_STATE || state === PAUSED_STATE
            ? selectedAreas[0]
            : null;
    }
    async selectServiceAreas(newAreas) {
        const supportedAreas = new Map(this.getMatterServiceAreas().map((area) => [area.areaId, area]));
        const selectedAreas = this.normalizeMatterAreaIds(newAreas);
        const unsupportedArea = selectedAreas.find((areaId) => !supportedAreas.has(areaId));
        this.platform.log.info(`Matter service area selection request for ${this.getVacuumName()}: ${selectedAreas.join(", ") || "none"}.`);
        if (unsupportedArea !== undefined) {
            return {
                status: SERVICE_AREA_SELECT_STATUS.UNSUPPORTED_AREA,
                statusText: `Area ${unsupportedArea} is not available from the Roborock room map.`,
            };
        }
        const selectedMapIds = this.getSelectedServiceAreaMapIds(selectedAreas
            .map((areaId) => supportedAreas.get(areaId))
            .filter((area) => area !== undefined));
        if (selectedMapIds.length > 1) {
            this.platform.log.warn(`Ignoring Matter service area selection spanning multiple Roborock maps for ${this.getVacuumName()}; select areas from one map at a time.`);
            return {
                status: SERVICE_AREA_SELECT_STATUS.INVALID_SET,
                statusText: "Select service areas from only one Roborock map at a time.",
            };
        }
        this.selectedServiceAreaIds = selectedAreas;
        if (selectedAreas.length > 0) {
            const areaNames = selectedAreas
                .map((areaId) => supportedAreas.get(areaId))
                .filter((area) => area !== undefined)
                .map((area) => this.formatServiceAreaName(area));
            this.platform.log.info(`Selected Matter service area(s) for ${this.getVacuumName()}: ${areaNames.join(", ")}.`);
        }
        else {
            this.platform.log.info(`Cleared Matter service area selection for ${this.getVacuumName()}.`);
        }
        // Defer the publish so the selectAreas handler returns promptly; the
        // snapshot is rebuilt at execution time from the stored selection.
        const publishTimer = scheduleTimer(() => {
            void this.updateMatterState(this.buildClusters(), "service area selection").catch((error) => {
                this.platform.log.warn(`Unable to update Matter service area selection for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, 0);
        unrefTimer(publishTimer);
        return {
            status: SERVICE_AREA_SELECT_STATUS.SUCCESS,
            statusText: "",
        };
    }
    getMatterServiceAreas() {
        var _a;
        const getRoomMappingsForDevice = this.api.getRoomMappingsForDevice;
        if (typeof getRoomMappingsForDevice !== "function") {
            return [];
        }
        const rooms = getRoomMappingsForDevice.call(this.api, this.getDuid());
        if (!Array.isArray(rooms)) {
            return [];
        }
        const areas = [];
        const mapsById = new Map(this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map]));
        const seenAreaIds = new Set();
        for (const room of rooms) {
            const roomRecord = this.asRecord(room);
            const segmentId = this.getNumberFromValue(roomRecord === null || roomRecord === void 0 ? void 0 : roomRecord.segmentId);
            const mapId = this.getMatterMapId(roomRecord === null || roomRecord === void 0 ? void 0 : roomRecord.mapId);
            const areaId = segmentId === null
                ? null
                : this.getMatterAreaId(segmentId, mapId, seenAreaIds);
            if (areaId === null ||
                segmentId === null ||
                !Number.isInteger(segmentId) ||
                segmentId < 0 ||
                seenAreaIds.has(areaId)) {
                continue;
            }
            seenAreaIds.add(areaId);
            areas.push({
                areaId,
                segmentId,
                mapId,
                mapName: mapId === null ? null : ((_a = mapsById.get(mapId)) === null || _a === void 0 ? void 0 : _a.name) || null,
                name: this.toMatterLocationName(roomRecord === null || roomRecord === void 0 ? void 0 : roomRecord.name, segmentId),
            });
        }
        return areas;
    }
    getMatterServiceAreaMaps(areas) {
        var _a;
        // Matter controllers can hang if supportedMaps advertises maps with no
        // matching supportedAreas, or if supportedAreas reference a mapId that has
        // no supportedMaps entry. Build supportedMaps from exactly the maps that
        // have areas, preferring Roborock-reported map names and falling back to
        // the area's map name or a generated label.
        const roborockMapsById = new Map(this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map]));
        const maps = [];
        const seenMapIds = new Set();
        for (const area of areas) {
            if (area.mapId === null || seenMapIds.has(area.mapId)) {
                continue;
            }
            seenMapIds.add(area.mapId);
            maps.push({
                mapId: area.mapId,
                name: ((_a = roborockMapsById.get(area.mapId)) === null || _a === void 0 ? void 0 : _a.name) ||
                    area.mapName ||
                    `Roborock Map ${area.mapId}`,
            });
        }
        return maps;
    }
    getMatterServiceAreaMapsFromRoborock() {
        const getMapListForDevice = this.api.getMapListForDevice;
        if (typeof getMapListForDevice !== "function") {
            return [];
        }
        const maps = getMapListForDevice.call(this.api, this.getDuid());
        if (!Array.isArray(maps)) {
            return [];
        }
        const supportedMaps = [];
        const seenMapIds = new Set();
        for (const map of maps) {
            const mapRecord = this.asRecord(map);
            const mapId = this.getMatterMapId(mapRecord === null || mapRecord === void 0 ? void 0 : mapRecord.mapId);
            if (mapId === null || seenMapIds.has(mapId)) {
                continue;
            }
            seenMapIds.add(mapId);
            supportedMaps.push({
                mapId,
                name: this.toMatterMapName(mapRecord === null || mapRecord === void 0 ? void 0 : mapRecord.name, mapId),
            });
        }
        return supportedMaps;
    }
    getMatterAreaId(segmentId, mapId, usedAreaIds) {
        let areaId = mapId === null
            ? segmentId
            : mapId * MATTER_AREA_ID_MAP_MULTIPLIER + segmentId;
        if (!Number.isSafeInteger(areaId) || areaId > MATTER_AREA_ID_MAX) {
            areaId = this.getHashedMatterAreaId(mapId, segmentId);
        }
        while (usedAreaIds.has(areaId)) {
            areaId = areaId >= MATTER_AREA_ID_MAX ? 0 : areaId + 1;
        }
        return areaId;
    }
    getHashedMatterAreaId(mapId, segmentId) {
        const source = `${mapId !== null && mapId !== void 0 ? mapId : "none"}:${segmentId}`;
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) {
            hash ^= source.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash;
    }
    getMatterMapId(value) {
        const mapId = this.getNumberFromValue(value);
        return mapId !== null && Number.isInteger(mapId) && mapId >= 0
            ? mapId
            : null;
    }
    logMatterServiceAreaSummary(areas, maps) {
        const summary = [
            this.getDuid(),
            areas
                .map((area) => { var _a; return `${area.areaId}:${(_a = area.mapId) !== null && _a !== void 0 ? _a : "none"}:${area.name}`; })
                .join("|"),
            maps.map((map) => `${map.mapId}:${map.name}`).join("|"),
        ].join(";");
        if (summary === this.lastServiceAreaSummary) {
            return;
        }
        this.lastServiceAreaSummary = summary;
        if (areas.length === 0) {
            this.platform.log.info(`Matter Service Area is enabled for ${this.getVacuumName()}, but no Roborock rooms are available to expose yet.`);
            return;
        }
        this.platform.log.info(`Matter Service Area for ${this.getVacuumName()}: exposing ${areas.length} room(s)` +
            `${maps.length > 0 ? ` on ${maps.length} map(s)` : ""}: ${areas
                .map((area) => this.getMatterLocationDisplayName(area, maps.length > 1))
                .join(", ")}.`);
    }
    getSelectedServiceAreaSegments() {
        if (!this.isServiceAreaEnabled()) {
            return [];
        }
        const areasById = new Map(this.getMatterServiceAreas().map((area) => [area.areaId, area]));
        return this.selectedServiceAreaIds
            .map((areaId) => areasById.get(areaId))
            .filter((area) => area !== undefined);
    }
    normalizeMatterAreaIds(newAreas) {
        if (!Array.isArray(newAreas)) {
            return [];
        }
        const selectedAreas = [];
        const seenAreaIds = new Set();
        for (const area of newAreas) {
            const areaId = this.getNumberFromValue(area);
            if (areaId === null ||
                !Number.isInteger(areaId) ||
                areaId < 0 ||
                seenAreaIds.has(areaId)) {
                continue;
            }
            seenAreaIds.add(areaId);
            selectedAreas.push(areaId);
        }
        return selectedAreas;
    }
    clampMatterName(name, maxLength, fallback) {
        const normalizedName = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
        const value = normalizedName || fallback;
        return value.length > maxLength
            ? value.slice(0, maxLength).trim() || fallback
            : value;
    }
    toMatterLocationName(name, areaId) {
        return this.clampMatterName(name, MATTER_LOCATION_NAME_MAX_LENGTH, `Room ${areaId}`);
    }
    toMatterMapName(name, mapId) {
        return this.clampMatterName(name, MATTER_MAP_NAME_MAX_LENGTH, `Roborock Map ${mapId}`);
    }
    formatServiceAreaName(area) {
        return area.mapName ? `${area.name} (${area.mapName})` : area.name;
    }
    getMatterLocationDisplayName(area, includeMapName) {
        if (!includeMapName || !area.mapName) {
            return area.name;
        }
        const fallbackName = this.clampMatterName(`${area.mapName} - Room ${area.segmentId}`, MATTER_LOCATION_NAME_MAX_LENGTH, area.name);
        return this.clampMatterName(`${area.mapName} - ${area.name}`, MATTER_LOCATION_NAME_MAX_LENGTH, fallbackName);
    }
    getSelectedServiceAreaMapIds(selectedAreas) {
        const selectedMapIds = new Set();
        for (const area of selectedAreas) {
            if (area.mapId !== null) {
                selectedMapIds.add(area.mapId);
            }
        }
        return Array.from(selectedMapIds);
    }
    async loadMatterMapIfNeeded(duid, targetMapId) {
        if (targetMapId === null) {
            return;
        }
        const currentMapId = this.getCurrentMatterMapId();
        if (currentMapId === targetMapId) {
            return;
        }
        const loadMap = this.api.load_multi_map;
        if (typeof loadMap !== "function") {
            throw new Error(`Roborock map ${targetMapId} is not currently loaded and this plugin cannot switch maps.`);
        }
        this.platform.log.info(`Loading Roborock map ${targetMapId} for ${this.getVacuumName()} before selected-area cleaning.`);
        try {
            await loadMap.call(this.api, duid, targetMapId, this.getMatterMapLoadCommandOptions());
        }
        catch (error) {
            const currentMapIdAfterError = this.getCurrentMatterMapId();
            if (currentMapIdAfterError === targetMapId) {
                this.platform.log.warn(`Roborock map ${targetMapId} for ${this.getVacuumName()} became active even though the map-load acknowledgement failed: ${this.getErrorMessage(error)}`);
                return;
            }
            throw error;
        }
    }
    getCurrentMatterMapId() {
        const getCurrentMapIdForDevice = this.api.getCurrentMapIdForDevice;
        if (typeof getCurrentMapIdForDevice !== "function") {
            return null;
        }
        const currentMapId = getCurrentMapIdForDevice.call(this.api, this.getDuid());
        return this.getMatterMapId(currentMapId);
    }
    isServiceAreaEnabled() {
        return this.platform.platformConfig.enableMatterServiceArea !== false;
    }
    isPowerSourceEnabled() {
        return this.platform.platformConfig.enableMatterPowerSource !== false;
    }
    isCleanModeEnabled() {
        return this.platform.platformConfig.enableMatterCleanMode !== false;
    }
    isExtendedOperationalStateEnabled() {
        return (this.platform.platformConfig.enableMatterExtendedOperationalStates ===
            true);
    }
    isChargingDockedStateEnabled() {
        return (this.platform.platformConfig.enableMatterChargingDockedStates === true);
    }
    /**
     * Battery percentage at which a docked robot switches from Charging to
     * Docked on the Matter tile. Defaults to 100 (charging until full); users
     * with worn batteries can lower it so the tile stops claiming Charging once
     * their realistic full level is reached.
     */
    getChargedBatteryThreshold() {
        const raw = this.platform.platformConfig.matterChargedBatteryThreshold;
        const value = typeof raw === "string" ? Number(raw) : raw;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return 100;
        }
        return Math.min(100, Math.max(1, Math.round(value)));
    }
    resolveChargingDockedDisplayState(fallbackState) {
        const battery = this.getNumberStatus("battery");
        if (battery === null) {
            return fallbackState;
        }
        return battery < this.getChargedBatteryThreshold()
            ? RVC_OPERATIONAL_STATE.CHARGING
            : RVC_OPERATIONAL_STATE.DOCKED;
    }
    getOperationalStateList() {
        const baseList = this.isExtendedOperationalStateEnabled()
            ? RVC_OPERATIONAL_STATE_LIST
            : RVC_BASIC_OPERATIONAL_STATE_LIST;
        // Matter requires operationalState to be a member of operationalStateList,
        // so only advertise CHARGING/DOCKED when we may actually publish them.
        return this.isChargingDockedStateEnabled()
            ? [...baseList, ...RVC_CHARGING_DOCKED_STATE_LIST]
            : baseList;
    }
    getBatteryChargeLevel(battery) {
        if (battery !== null && battery <= 10) {
            return BATTERY_CHARGE_LEVEL.CRITICAL;
        }
        if (battery !== null && battery < 20) {
            return BATTERY_CHARGE_LEVEL.WARNING;
        }
        return BATTERY_CHARGE_LEVEL.OK;
    }
    getBatteryChargeState(battery, chargeStatus, state) {
        if (battery === null) {
            return BATTERY_CHARGE_STATE.UNKNOWN;
        }
        if (state === 100 || (battery >= 100 && chargeStatus !== 0)) {
            return BATTERY_CHARGE_STATE.IS_AT_FULL_CHARGE;
        }
        if (chargeStatus !== null) {
            return chargeStatus !== 0
                ? BATTERY_CHARGE_STATE.IS_CHARGING
                : BATTERY_CHARGE_STATE.IS_NOT_CHARGING;
        }
        if (state === 8) {
            return BATTERY_CHARGE_STATE.IS_CHARGING;
        }
        return BATTERY_CHARGE_STATE.UNKNOWN;
    }
    getBatteryTimeToFullCharge(battery, chargeState) {
        if (battery === null) {
            return null;
        }
        if (chargeState === BATTERY_CHARGE_STATE.IS_AT_FULL_CHARGE) {
            return 0;
        }
        if (chargeState !== BATTERY_CHARGE_STATE.IS_CHARGING) {
            return null;
        }
        return (Math.ceil(100 - battery) * BATTERY_ESTIMATED_CHARGE_SECONDS_PER_PERCENT);
    }
    getOperationalState(state = this.getNumberStatus("state"), chargeStatus = this.getNumberStatus("charge_status")) {
        const operationalState = this.getRoborockOperationalState(state, chargeStatus);
        return this.toControllerOperationalState(operationalState);
    }
    getRoborockOperationalState(state, chargeStatus) {
        switch (state) {
            case 5: // Cleaning
            case 11: // Spot Cleaning
            case 16: // Go To
            case 17: // Zone Clean
            case 18: // Room Clean
            case 4: // Remote Control
            case 7: // Manual Mode
                return RVC_OPERATIONAL_STATE.RUNNING;
            case 10: // Paused
                return RVC_OPERATIONAL_STATE.PAUSED;
            case 6: // Returning Dock
            case 15: // Docking
            case 26: // Going to wash the mop
                return RVC_OPERATIONAL_STATE.SEEKING_CHARGER;
            case 8: // Charging
                return RVC_OPERATIONAL_STATE.CHARGING;
            case 9: // Charging Error
            case 12: // In Error
                return RVC_OPERATIONAL_STATE.ERROR;
            case 22: // Emptying dust container
                return RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN;
            case 23: // Washing the mop
                return RVC_OPERATIONAL_STATE.CLEANING_MOP;
            case 29: // Mapping
                return RVC_OPERATIONAL_STATE.UPDATING_MAPS;
            case 100: // Fully Charged
                return RVC_OPERATIONAL_STATE.DOCKED;
            default:
                if (chargeStatus !== null && chargeStatus !== 0) {
                    return RVC_OPERATIONAL_STATE.CHARGING;
                }
                return RVC_OPERATIONAL_STATE.STOPPED;
        }
    }
    toControllerOperationalState(operationalState) {
        if (this.isExtendedOperationalStateEnabled() &&
            operationalState === RVC_OPERATIONAL_STATE.SEEKING_CHARGER) {
            return operationalState;
        }
        if (this.isChargingDockedStateEnabled() &&
            (operationalState === RVC_OPERATIONAL_STATE.CHARGING ||
                operationalState === RVC_OPERATIONAL_STATE.DOCKED)) {
            // Opt-in: report real charging/docked states so Apple Home shows
            // "Charging"/"Docked" on the tile instead of "Ready". The battery
            // percentage is the discriminator between the two: worn batteries can
            // make the robot claim "fully charged" (or drop the charging flag)
            // early, so trust the percentage against the configured threshold and
            // only fall back to the state-based value when no battery reading is
            // available.
            return this.resolveChargingDockedDisplayState(operationalState);
        }
        switch (operationalState) {
            case RVC_OPERATIONAL_STATE.ERROR:
                return RVC_OPERATIONAL_STATE.STOPPED;
            case RVC_OPERATIONAL_STATE.SEEKING_CHARGER:
                return RVC_OPERATIONAL_STATE.STOPPED;
            case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
            case RVC_OPERATIONAL_STATE.CLEANING_MOP:
            case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
                return RVC_OPERATIONAL_STATE.RUNNING;
            case RVC_OPERATIONAL_STATE.CHARGING:
            case RVC_OPERATIONAL_STATE.DOCKED:
                return RVC_OPERATIONAL_STATE.STOPPED;
            default:
                return operationalState;
        }
    }
    isInCleaningRunMode(operationalState) {
        switch (operationalState) {
            case RVC_OPERATIONAL_STATE.RUNNING:
            case RVC_OPERATIONAL_STATE.PAUSED:
            case RVC_OPERATIONAL_STATE.SEEKING_CHARGER:
            case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
            case RVC_OPERATIONAL_STATE.CLEANING_MOP:
            case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
                return true;
            default:
                return false;
        }
    }
    rememberLiveStatus(property, value) {
        if (value !== null) {
            this.liveStatus.set(property, value);
            this.liveStatusUpdatedAt = Date.now();
        }
    }
    rememberHomeDataStatus(data) {
        const message = this.asRecord(data);
        const value = message === null || message === void 0 ? void 0 : message.val;
        if (typeof value !== "string") {
            return;
        }
        let homeData;
        try {
            homeData = JSON.parse(value);
        }
        catch (_a) {
            return;
        }
        const home = this.asRecord(homeData);
        const devices = Array.isArray(home === null || home === void 0 ? void 0 : home.devices) ? home.devices : [];
        const device = devices
            .map((entry) => this.asRecord(entry))
            .find((entry) => (entry === null || entry === void 0 ? void 0 : entry.duid) === this.getDuid());
        const deviceStatus = this.asRecord(device === null || device === void 0 ? void 0 : device.deviceStatus);
        if (!deviceStatus) {
            return;
        }
        this.rememberLiveStatus("state", this.getNumberFromValue(deviceStatus.state));
        this.rememberLiveStatus("battery", this.getNumberFromValue(deviceStatus.battery));
        this.rememberLiveStatus("charge_status", this.getNumberFromValue(deviceStatus.charge_status));
    }
    getNumberStatus(property) {
        // Prefer the freshest value from a live message, falling back to the
        // HomeData snapshot for properties live messages do not carry.
        // A stale live cache must not shadow the periodically refreshed cloud
        // snapshot forever (dead poller, connectivity loss): live values older
        // than the staleness window fall back to HomeData, which self-heals.
        const liveValue = this.liveStatus.get(property);
        if (liveValue !== undefined &&
            Date.now() - this.liveStatusUpdatedAt < LIVE_STATUS_STALENESS_MS) {
            return liveValue;
        }
        const value = this.api.getVacuumDeviceStatus(this.getDuid(), property);
        return this.getNumberFromValue(value);
    }
    getNumberFromValue(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string" && value.trim() !== "") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }
    extractStatusUpdate(data) {
        const rootMessage = this.asRecord(data);
        const dps = this.asRecord(rootMessage === null || rootMessage === void 0 ? void 0 : rootMessage.dps);
        if (dps) {
            const status = {};
            if (Object.prototype.hasOwnProperty.call(dps, "121")) {
                status.state = dps["121"];
            }
            if (Object.prototype.hasOwnProperty.call(dps, "122")) {
                status.battery = dps["122"];
            }
            if (Object.prototype.hasOwnProperty.call(dps, "123")) {
                status.charge_status = dps["123"];
            }
            return Object.keys(status).length > 0 ? status : null;
        }
        const payload = Array.isArray(data) ? data : data ? [data] : [];
        const message = this.asRecord(payload[0]);
        if (!message) {
            return null;
        }
        const hasStatus = Object.prototype.hasOwnProperty.call(message, "state") ||
            Object.prototype.hasOwnProperty.call(message, "battery") ||
            Object.prototype.hasOwnProperty.call(message, "charge_status") ||
            Object.prototype.hasOwnProperty.call(message, "clean_area") ||
            Object.prototype.hasOwnProperty.call(message, "clean_time");
        return hasStatus ? message : null;
    }
    getLiveMessageForThisAccessory(data) {
        return (0, live_message_1.getLiveMessageForThisAccessory)(data, {
            getDuid: () => this.getDuid(),
            getVacuumName: () => this.getVacuumName(),
            shouldAcceptUnscopedLiveMessage: () => this.platform.shouldAcceptUnscopedLiveMessage(),
            logDebug: (message) => this.platform.log.debug(message),
        });
    }
    asRecord(value) {
        return value !== null && typeof value === "object"
            ? value
            : null;
    }
    setOptimisticState(partialClusters, action) {
        this.optimisticClusters = this.mergeClusterState(this.getActiveOptimisticState() || {}, partialClusters);
        this.optimisticExpiresAt = Date.now() + OPTIMISTIC_STATE_TTL_MS;
        this.optimisticGeneration += 1;
        this.optimisticAction = action;
        this.contradictingLiveStateCount = 0;
        return this.optimisticGeneration;
    }
    reconcileOptimisticStateWithLive(operationalState, roborockState, chargeStatus) {
        var _a;
        const optimistic = this.getActiveOptimisticState();
        const expected = (_a = optimistic === null || optimistic === void 0 ? void 0 : optimistic.rvcOperationalState) === null || _a === void 0 ? void 0 : _a.operationalState;
        if (typeof expected !== "number") {
            this.contradictingLiveStateCount = 0;
            return;
        }
        if (this.doesLiveStateConfirmOptimisticState(expected, operationalState, roborockState, chargeStatus)) {
            this.clearOptimisticState();
            return;
        }
        // While a start/resume/area-clean is still spinning up, cloud-only models
        // (e.g. S8 / roborock.vacuum.a51) keep reporting docked/charging for tens of
        // seconds before they report Cleaning. During the recent-command window,
        // treat those lagging reports as transitional rather than contradictions, so
        // the optimistic Cleaning state is not starved and Apple Home does not snap
        // the tile back to Docked right after Start (issue #4).
        if (expected === RVC_OPERATIONAL_STATE.RUNNING &&
            this.isRoborockDockedOrCharging(roborockState, chargeStatus) &&
            this.hasRecentlyCommandedCleaning()) {
            this.contradictingLiveStateCount = 0;
            return;
        }
        // The command was acknowledged but the robot reports a different state.
        // Tolerate a couple of transitional reports, then trust the live state so
        // an optimistic value cannot stay stuck until the TTL expires (e.g. a start
        // the robot ignored because the bin is full or it is off the dock).
        this.contradictingLiveStateCount += 1;
        if (this.contradictingLiveStateCount >= OPTIMISTIC_CONTRADICTION_LIMIT) {
            this.platform.log.debug(`Clearing optimistic Matter state for ${this.getVacuumName()} after ${this.contradictingLiveStateCount} contradicting Roborock updates (expected ${expected}, got ${operationalState}).`);
            this.clearOptimisticState();
        }
    }
    doesLiveStateConfirmOptimisticState(expected, actual, roborockState, chargeStatus) {
        if (expected === actual) {
            return true;
        }
        if (this.optimisticAction === "return to dock" &&
            expected === RVC_OPERATIONAL_STATE.RUNNING &&
            !this.isInCleaningRunMode(actual) &&
            this.isRoborockDockedOrCharging(roborockState, chargeStatus)) {
            return true;
        }
        if (expected === RVC_OPERATIONAL_STATE.RUNNING &&
            this.isInCleaningRunMode(actual)) {
            return true;
        }
        if (expected === RVC_OPERATIONAL_STATE.STOPPED &&
            !this.isInCleaningRunMode(actual)) {
            return true;
        }
        return (expected === RVC_OPERATIONAL_STATE.SEEKING_CHARGER &&
            (actual === RVC_OPERATIONAL_STATE.CHARGING ||
                actual === RVC_OPERATIONAL_STATE.DOCKED));
    }
    isRoborockDockedOrCharging(roborockState, chargeStatus) {
        return roborockState === 8 || roborockState === 100 || !!chargeStatus;
    }
    isDockedOrChargingNow() {
        return this.isRoborockDockedOrCharging(this.getNumberStatus("state"), this.getNumberStatus("charge_status"));
    }
    async publishCurrentMatterState(reason, options = {}) {
        if (options.clearOptimistic === true) {
            this.clearOptimisticState();
        }
        const updated = await this.updateMatterState(this.buildClusters(), reason);
        if (updated) {
            this.ensureMatterStateHeartbeat();
        }
    }
    ensureMatterStateHeartbeat() {
        if (!this.registered || this.matterStateHeartbeatTimer) {
            return;
        }
        const heartbeatTimer = scheduleTimer(() => {
            this.matterStateHeartbeatTimer = null;
            void this.publishCurrentMatterState("Matter state heartbeat")
                .catch((error) => {
                this.platform.log.debug(`Unable to publish Matter state heartbeat for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            })
                .finally(() => {
                // Re-arm even after a failed or suppressed publish. Previously the
                // heartbeat chain only continued after a successful publish, so one
                // transient Matter error silently disabled the safety net until the
                // next live Roborock message happened to arrive.
                if (this.registered) {
                    this.ensureMatterStateHeartbeat();
                }
            });
        }, MATTER_STATE_HEARTBEAT_INTERVAL_MS);
        this.matterStateHeartbeatTimer = heartbeatTimer;
        unrefTimer(heartbeatTimer);
    }
    applyOptimisticState(clusters) {
        const optimistic = this.getActiveOptimisticState();
        return optimistic ? this.mergeClusterState(clusters, optimistic) : clusters;
    }
    getActiveOptimisticState() {
        if (!this.optimisticClusters) {
            return null;
        }
        if (Date.now() > this.optimisticExpiresAt) {
            this.clearOptimisticState();
            return null;
        }
        return this.optimisticClusters;
    }
    clearOptimisticState() {
        this.optimisticClusters = null;
        this.optimisticExpiresAt = 0;
        this.optimisticAction = null;
        this.optimisticGeneration += 1;
        this.contradictingLiveStateCount = 0;
    }
    dispatchRoborockMatterCommand(action, command, options = {}) {
        const startedAt = Date.now();
        void command()
            .then(() => {
            this.logMatterCommandDuration(action, startedAt);
            this.schedulePostCommandStatusRefresh(action);
        })
            .catch(async (error) => {
            if (this.isDeviceNotReadyError(error)) {
                // The command raced a plugin restart: Roborock login/device setup
                // has not finished yet. Log calmly, roll the optimistic state back,
                // and let the user retry once startup completes instead of showing
                // a scary error with a misleading stack.
                this.platform.log.warn(`Matter ${action} command for ${this.getVacuumName()} arrived before the Roborock connection finished starting up. Try again in a few seconds. ${this.getErrorMessage(error)}`);
                await this.recoverMatterStateAfterFailedCommand(action);
                return;
            }
            if (this.isMatterCommandTimeoutError(error)) {
                this.platform.log.warn(`Matter ${action} command for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`);
                this.schedulePostCommandStatusRefresh(action, {
                    acknowledgementTimedOut: true,
                });
                if (options.retryReturnToDockIfStillActive) {
                    this.scheduleReturnToDockRetry(command);
                }
                return;
            }
            this.platform.log.error(`Error sending Matter ${action} command to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            await this.recoverMatterStateAfterFailedCommand(action);
        });
    }
    scheduleReturnToDockRetry(command) {
        if (this.returnToDockRetryPending) {
            return;
        }
        this.returnToDockRetryPending = true;
        const retryTimer = scheduleTimer(() => {
            this.returnToDockRetryPending = false;
            void this.refreshMatterStatusBeforeRetry()
                .then(() => {
                if (!this.shouldRetryReturnToDock()) {
                    this.platform.log.debug(`Skipping Matter return to dock retry for ${this.getVacuumName()} because Roborock no longer reports active cleaning.`);
                    return;
                }
                const startedAt = Date.now();
                this.platform.log.warn(`Retrying Matter return to dock command for ${this.getVacuumName()} because Roborock still reports active cleaning after the first command timed out.`);
                return command()
                    .then(() => {
                    this.logMatterCommandDuration("return to dock retry", startedAt);
                    this.schedulePostCommandStatusRefresh("return to dock retry");
                })
                    .catch(async (error) => {
                    if (this.isMatterCommandTimeoutError(error)) {
                        this.platform.log.warn(`Matter return to dock retry for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`);
                        this.schedulePostCommandStatusRefresh("return to dock retry", {
                            acknowledgementTimedOut: true,
                        });
                        return;
                    }
                    this.platform.log.error(`Error sending Matter return to dock retry to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
                    await this.recoverMatterStateAfterFailedCommand("return to dock retry");
                });
            })
                .catch((error) => {
                this.platform.log.debug(`Unable to evaluate Matter return to dock retry for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, MATTER_RETURN_TO_DOCK_RETRY_DELAY_MS);
        unrefTimer(retryTimer);
    }
    async refreshMatterStatusBeforeRetry() {
        const refreshStatus = this.api.getStatus;
        if (typeof refreshStatus !== "function") {
            return;
        }
        await refreshStatus.call(this.api, this.getDuid(), this.getMatterStatusRefreshOptions());
        await this.updateMatterStateFromRoborock();
    }
    shouldRetryReturnToDock() {
        const state = this.getNumberStatus("state");
        const chargeStatus = this.getNumberStatus("charge_status");
        if (this.isRoborockDockedOrCharging(state, chargeStatus)) {
            return false;
        }
        return this.isRoborockActivelyCleaningAwayFromDock(state);
    }
    isRoborockActivelyCleaningAwayFromDock(state) {
        switch (state) {
            case 4: // Remote Control
            case 5: // Cleaning
            case 7: // Manual Mode
            case 10: // Paused
            case 11: // Spot Cleaning
            case 16: // Go To
            case 17: // Zone Clean
            case 18: // Room Clean
            case 29: // Mapping
                return true;
            default:
                return false;
        }
    }
    async recoverMatterStateAfterFailedCommand(action) {
        try {
            await this.publishCurrentMatterState(`${action} command failure recovery`, { clearOptimistic: true });
        }
        catch (error) {
            this.platform.log.warn(`Unable to recover Matter state after failed ${action} command for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
        }
    }
    isMatterCommandTimeoutError(error) {
        return /timed out after \d+ seconds/.test(this.getErrorMessage(error));
    }
    isDeviceNotReadyError(error) {
        if (error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ROBOROCK_DEVICE_NOT_READY") {
            return true;
        }
        // Also match the upstream phrasing used by getServerTimers and
        // updateServerTimer ("Vacuum <duid> is not initialized.").
        return /is not initialized/i.test(this.getErrorMessage(error));
    }
    isMatterInitializingError(error) {
        return /\bis still initializing\b/i.test(this.getErrorMessage(error));
    }
    scheduleMatterInitializationRetry(reason, error) {
        if (this.matterInitializationRetryPending) {
            return;
        }
        const delayMs = MATTER_INITIALIZATION_RETRY_DELAYS_MS[this.matterInitializationRetryAttempt];
        if (delayMs === undefined) {
            this.platform.log.debug(`Matter state update after ${reason} for ${this.getVacuumName()} is still waiting on Homebridge endpoint initialization; suppressing additional startup retries. Last error: ${this.getErrorMessage(error)}`);
            return;
        }
        this.matterInitializationRetryAttempt += 1;
        this.matterInitializationRetryPending = true;
        this.platform.log.debug(`Matter state update after ${reason} for ${this.getVacuumName()} was delayed because Homebridge says the endpoint is still initializing; retrying in ${delayMs} ms.`);
        const retryTimer = scheduleTimer(() => {
            this.matterInitializationRetryPending = false;
            this.scheduleMatterStateRefresh(`endpoint initialization retry (${reason})`);
        }, delayMs);
        unrefTimer(retryTimer);
    }
    logMatterCommandDuration(action, startedAt) {
        const durationMs = Date.now() - startedAt;
        const transport = this.getTransportDescription();
        const message = `Matter ${action} command for ${this.getVacuumName()} was acknowledged ` +
            `by Roborock in ${durationMs} ms${transport ? ` via ${transport}` : ""}.`;
        if (durationMs >= SLOW_MATTER_COMMAND_MS) {
            this.platform.log.warn(`Slow ${message}`);
            return;
        }
        this.platform.log.info(message);
    }
    schedulePostCommandStatusRefresh(action, options = {}) {
        const refreshStatus = this.api.getStatus;
        if (!this.registered || typeof refreshStatus !== "function") {
            return;
        }
        const refreshDelays = options.acknowledgementTimedOut
            ? MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS
            : action === "return to dock"
                ? MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS
                : MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS;
        for (const delayMs of refreshDelays) {
            const refreshTimer = scheduleTimer(() => {
                void refreshStatus
                    .call(this.api, this.getDuid(), this.getMatterStatusRefreshOptions())
                    .then(() => this.updateMatterStateFromRoborock())
                    .catch((error) => {
                    this.platform.log.debug(`Unable to refresh Matter status after ${action} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
                });
            }, delayMs);
            unrefTimer(refreshTimer);
        }
    }
    getMatterStatusRefreshOptions() {
        const options = { force: true };
        if (this.platform.platformConfig.preferCloudForMatterCommands) {
            options.preferCloud = true;
        }
        return options;
    }
    getTransportDescription() {
        const diagnostics = typeof this.api.getTransportDiagnostics === "function"
            ? this.api.getTransportDiagnostics()
            : null;
        const transport = diagnostics && typeof diagnostics === "object"
            ? diagnostics[this.getDuid()]
            : null;
        if (!transport || typeof transport !== "object") {
            return "";
        }
        const lastTransport = "lastTransport" in transport ? String(transport.lastTransport) : "";
        const lastReason = "lastTransportReason" in transport
            ? String(transport.lastTransportReason)
            : "";
        if (lastTransport && lastReason) {
            return `${lastTransport} (${lastReason})`;
        }
        return lastTransport;
    }
    getErrorMessage(error) {
        if (error === undefined || error === null) {
            return "unknown error";
        }
        return error instanceof Error ? error.message : String(error);
    }
    mergeClusterState(base, override) {
        const merged = { ...base };
        for (const [cluster, attributes] of Object.entries(override)) {
            merged[cluster] = {
                ...(merged[cluster] || {}),
                ...attributes,
            };
        }
        return merged;
    }
    getVacuumName() {
        return (this.api.getVacuumDeviceInfo(this.getDuid(), "name") ||
            this.accessory.displayName ||
            "Roborock vacuum");
    }
    getDuid() {
        return String(this.accessory.context.duid);
    }
}
exports.default = RoborockMatterVacuumAccessory;
//# sourceMappingURL=matter_vacuum_accessory.js.map