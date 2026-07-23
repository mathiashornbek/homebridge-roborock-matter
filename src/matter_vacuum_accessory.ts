import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";

import RoborockPlatform from "./platform";
import { getLiveMessageForThisAccessory } from "./live_message";

const MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS = 2000;
const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = 2500;

type MatterAccessory = {
  UUID: string;
  displayName: string;
  name?: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision?: string;
  context: Record<string, unknown>;
  clusters?: Record<string, Record<string, unknown>>;
  handlers?: Record<string, Record<string, unknown>>;
  getState?: (cluster: string, attribute: string) => Promise<unknown>;
};

type MatterClusterState = Record<string, Record<string, unknown>>;

type RoborockDevice = {
  duid: string;
  name?: string;
};

type MatterServiceArea = {
  areaId: number;
  segmentId: number;
  mapId: number | null;
  mapName: string | null;
  name: string;
};

type MatterServiceAreaMap = {
  mapId: number;
  name: string;
};

type MatterCleanModeCapabilities = {
  canVacuum?: boolean;
  canMop?: boolean;
  canControlFanPower?: boolean;
  // Robots with a verified fifth suction level (B01/Q7 wind 5 = v1 fan
  // power 108). Classic models stay off until a reliable capability signal
  // exists — model guessing is exactly what this fork is moving away from.
  canMaxPlusFanPower?: boolean;
  canControlWater?: boolean;
};

type RoborockCleanModeSettings = {
  cleanMode?: number;
  fanPower?: number;
  waterBoxMode?: number | null;
};

type RoborockCommandOptions = {
  waitForResult?: boolean;
  throwOnError?: boolean;
  preferCloud?: boolean;
  preferLocal?: boolean;
  allowOfflineCloudSend?: boolean;
  requestTimeoutMs?: number;
};

type RoborockStatusRefreshOptions = {
  force?: boolean;
  preferCloud?: boolean;
};

type MatterCommandDispatchOptions = {
  retryReturnToDockIfStillActive?: boolean;
};

function scheduleTimer(
  callback: () => void,
  delayMs: number
): ReturnType<typeof nodeSetTimeout> {
  const setTimer =
    typeof globalThis.setTimeout === "function"
      ? globalThis.setTimeout
      : nodeSetTimeout;

  return setTimer(callback, delayMs);
}

function unrefTimer(timer: ReturnType<typeof nodeSetTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

function clearTimer(timer: ReturnType<typeof nodeSetTimeout>): void {
  const clear =
    typeof globalThis.clearTimeout === "function"
      ? globalThis.clearTimeout
      : nodeClearTimeout;

  clear(timer);
}

/**
 * The subset of the runtime Roborock API the Matter accessory depends on.
 * Methods that may be absent on older API builds are optional and guarded with
 * a `typeof === "function"` check before use.
 */
interface RoborockApi {
  getVacuumDeviceInfo(duid: string, property: string): string | undefined;
  getProductAttribute(
    duid: string,
    property: string
  ): string | null | undefined;
  getVacuumDeviceStatus(duid: string, property: string): unknown;
  app_start(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_stop(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_pause(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_charge(duid: string, options?: RoborockCommandOptions): Promise<void>;
  find_me?(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_segment_clean_by_ids(
    duid: string,
    segments: number[],
    options?: RoborockCommandOptions
  ): Promise<void>;
  getRoomMappingsForDevice?(duid: string): unknown;
  getMapListForDevice?(duid: string): unknown;
  getCurrentMapIdForDevice?(duid: string): unknown;
  getMatterCleanModeCapabilities?(duid: string): MatterCleanModeCapabilities;
  applyMatterCleanModeSettings?(
    duid: string,
    settings: RoborockCleanModeSettings,
    options?: RoborockCommandOptions
  ): Promise<void>;
  load_multi_map?(
    duid: string,
    mapId: number,
    options?: RoborockCommandOptions
  ): Promise<void>;
  getStatus?(
    duid: string,
    options?: RoborockStatusRefreshOptions
  ): Promise<void>;
  getTransportDiagnostics?(): Record<string, unknown> | null | undefined;
}

const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
// Live status entries older than this fall back to the HomeData snapshot.
const LIVE_STATUS_STALENESS_MS = 15 * 60 * 1000;

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

// Opt-in fan-power clean modes (enableFanPowerCleanModes, default off since
// Matter locks the announced mode set at commissioning — enabling requires
// one re-pair). Mode ids are stable and appended after the base modes.
// Fan power values are Roborock v1 codes (101-104); the B01/Q7 adapter
// translates them to its wind levels 1-4 transparently.
const CLEAN_MODE_VACUUM_QUIET = 3;
const CLEAN_MODE_VACUUM_BALANCED = 4;
const CLEAN_MODE_VACUUM_TURBO = 5;
const CLEAN_MODE_VACUUM_MAX = 6;
// Max+ (fifth suction level, v1 fan power 108) — only announced for robots
// whose protocol verifiably defines it (capabilities.canMaxPlusFanPower).
const CLEAN_MODE_VACUUM_MAX_PLUS = 7;

// Matter ModeBase common mode tags — combined with the RVC Vacuum tag.
// IMPORTANT: Apple Home ignores mode labels and renders its own localized
// names from these tags (verified in the field: a mode with only the
// Vacuum tag renders as plain "Vacuum"/"Støvsug"), so every suction level
// carries a distinct intensity tag: Auto, Quick, Quiet, Max.
const RVC_CLEAN_MODE_TAG_AUTO = 0;
const RVC_CLEAN_MODE_TAG_QUICK = 1;
const RVC_CLEAN_MODE_TAG_QUIET = 2;
const RVC_CLEAN_MODE_TAG_MAX = 7;
// RVC Clean Mode cluster tag: DeepClean — the closest semantic match for
// Roborock's Max+ boost level.
const RVC_CLEAN_MODE_TAG_DEEP_CLEAN = 16384;

const FAN_POWER_CLEAN_MODES: ReadonlyArray<{
  mode: number;
  label: string;
  fanPower: number;
  extraTags: number[];
}> = [
  {
    mode: CLEAN_MODE_VACUUM_QUIET,
    label: "Quiet Vacuum",
    fanPower: 101,
    extraTags: [RVC_CLEAN_MODE_TAG_QUIET],
  },
  {
    mode: CLEAN_MODE_VACUUM_BALANCED,
    label: "Balanced Vacuum",
    fanPower: 102,
    extraTags: [RVC_CLEAN_MODE_TAG_AUTO],
  },
  {
    mode: CLEAN_MODE_VACUUM_TURBO,
    label: "Turbo Vacuum",
    fanPower: 103,
    extraTags: [RVC_CLEAN_MODE_TAG_QUICK],
  },
  {
    mode: CLEAN_MODE_VACUUM_MAX,
    label: "Max Vacuum",
    fanPower: 104,
    extraTags: [RVC_CLEAN_MODE_TAG_MAX],
  },
];

const MAX_PLUS_FAN_POWER_CLEAN_MODE: (typeof FAN_POWER_CLEAN_MODES)[number] = {
  mode: CLEAN_MODE_VACUUM_MAX_PLUS,
  label: "Max+ Vacuum",
  fanPower: 108,
  extraTags: [RVC_CLEAN_MODE_TAG_DEEP_CLEAN],
};

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
} as const;

const RVC_OPERATIONAL_STATE_LIST = [
  RVC_OPERATIONAL_STATE.STOPPED,
  RVC_OPERATIONAL_STATE.RUNNING,
  RVC_OPERATIONAL_STATE.PAUSED,
  RVC_OPERATIONAL_STATE.ERROR,
  RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
] as const;

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
] as const;

const POWER_SOURCE_STATUS = {
  ACTIVE: 1,
  UNAVAILABLE: 3,
} as const;

const BATTERY_CHARGE_LEVEL = {
  OK: 0,
  WARNING: 1,
  CRITICAL: 2,
} as const;

const BATTERY_CHARGE_STATE = {
  UNKNOWN: 0,
  IS_CHARGING: 1,
  IS_AT_FULL_CHARGE: 2,
  IS_NOT_CHARGING: 3,
} as const;
const BATTERY_REPLACEABILITY = {
  UNSPECIFIED: 0,
} as const;
const BATTERY_ESTIMATED_CHARGE_SECONDS_PER_PERCENT = 180;

const SERVICE_AREA_SELECT_STATUS = {
  SUCCESS: 0,
  UNSUPPORTED_AREA: 1,
  INVALID_IN_MODE: 2,
  INVALID_SET: 3,
} as const;

const MATTER_LOCATION_NAME_MAX_LENGTH = 64;
const MATTER_MAP_NAME_MAX_LENGTH = 64;
const MATTER_AREA_ID_MAP_MULTIPLIER = 1_000_000;
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
const MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS = [2000, 15000] as const;
const MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS = [
  0, 2000, 5000, 10000, 20000, 30000,
] as const;
const MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS = [
  2000, 15000, 30000, 60000, 90000, 120000, 150000, 180000,
] as const;
const MATTER_RETURN_TO_DOCK_RETRY_DELAY_MS = 7000;
// Slow hosts (Raspberry Pi class hardware, busy child-bridge restarts) can
// keep the Homebridge Matter endpoint initializing well past 14 seconds, so
// back off further before giving up and waiting for the next live update.
const MATTER_INITIALIZATION_RETRY_DELAYS_MS = [
  1000, 3000, 10000, 30000, 60000,
] as const;
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
export default class RoborockMatterVacuumAccessory {
  private registered: boolean;
  private optimisticClusters: MatterClusterState | null = null;
  private optimisticExpiresAt = 0;
  private optimisticGeneration = 0;
  private optimisticAction: string | null = null;
  private contradictingLiveStateCount = 0;
  private lastCleaningCommandAt = 0;
  private selectedServiceAreaIds: number[] = [];
  private roomCleaningAreaConfirmed = false;
  private lastServiceAreaSummary = "";
  private liveStatusUpdatedAt = 0;
  private initialPublishLogged = false;
  private lastLoggedBatteryHalfPercent: number | null = null;
  private powerSourceResyncDone = false;
  private serviceAreaCurrentArea: number | null = null;
  // Area ids in which the robot was actually DETECTED via live map-position
  // tracking during the current run. Only detected areas are marked
  // completed when the robot moves on; the initial first-requested-room
  // guess falls back to pending instead of claiming a clean that may never
  // have happened. In-memory only: after a mid-run restart the worst case is
  // one pending-instead-of-completed entry until the run ends.
  private liveConfirmedServiceAreaIds = new Set<number>();
  // Per-cluster JSON of the last CONFIRMED publish. Used to skip republishing
  // identical cluster payloads on every poll/heartbeat. Safe against the
  // historical "Updating..." desync (see updateMatterState comment) because
  // (a) all publishes are serialized through matterPublishChain, (b) entries
  // are recorded only after the individual cluster write succeeded and are
  // dropped on failure, and (c) the heartbeat performs a forced full publish
  // every cycle, self-healing any residual divergence within a minute.
  private readonly lastPublishedClusterJson = new Map<string, string>();
  private serviceAreaProgress: Array<{ areaId: number; status: number }> = [];
  private selectedCleanMode = CLEAN_MODE_VACUUM;
  private selectedCleanModeNeedsApply = false;
  private lastVacuumFanPower: number | null = null;
  private lastWaterBoxMode: number | null = null;
  private matterInitializationRetryAttempt = 0;
  private matterInitializationRetryPending = false;
  private returnToDockRetryPending = false;
  private matterStateHeartbeatTimer: ReturnType<typeof nodeSetTimeout> | null =
    null;
  // Serializes every Matter publish so concurrent publishers (live messages,
  // refreshes, command paths) cannot land out of order. Homebridge defers each
  // updateAccessoryState via setImmediate, so without this chain an older
  // snapshot can overwrite a newer one and leave Apple Home on stale state.
  private matterPublishChain: Promise<void> = Promise.resolve();
  // Freshest status values seen from live Roborock messages. Preferred over the
  // slower HomeData snapshot when rebuilding clusters so registration snapshots
  // and attribute reads do not lag behind the latest push.
  private liveStatus: Map<string, number> = new Map();

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: MatterAccessory,
    device: RoborockDevice,
    isRegistered = false
  ) {
    this.registered = isRegistered;
    this.updateMetadata(device);
    this.restoreServiceAreaProgress();
  }

  private get api(): RoborockApi {
    return this.platform.roborockAPI as RoborockApi;
  }

  private getMatterCommandOptions(): RoborockCommandOptions {
    const options: RoborockCommandOptions = {
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

  private getMatterMapLoadCommandOptions(): RoborockCommandOptions {
    const options: RoborockCommandOptions = {
      ...this.getMatterCommandOptions(),
      // Some older Roborock models apply load_multi_map but never complete the
      // local pending request. The cloud path gives Matter room cleaning a
      // reliable acknowledgement without forcing all Matter commands to cloud.
      preferCloud: true,
    };
    delete options.preferLocal;
    return options;
  }

  private getMatterCleanModePrepCommandOptions(): RoborockCommandOptions {
    return {
      ...this.getMatterCommandOptions(),
      requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
    };
  }

  markRegistered(): void {
    this.registered = true;
    // Fresh registration: nothing is published on the new node yet.
    this.lastPublishedClusterJson.clear();
  }

  /**
   * Stops all background work for this accessory. Called on Homebridge
   * shutdown and when the accessory is unregistered, so no timer fires into a
   * torn-down bridge and no publish races a restarting child bridge.
   */
  dispose(): void {
    this.registered = false;
    if (this.matterStateHeartbeatTimer) {
      clearTimer(this.matterStateHeartbeatTimer);
      this.matterStateHeartbeatTimer = null;
    }
    this.clearOptimisticState();
  }

  scheduleMatterStateRefresh(reason: string, delayMs = 0): void {
    if (!this.registered) {
      return;
    }

    const timer = scheduleTimer(() => {
      void this.updateMatterStateFromRoborock().catch((error) => {
        this.platform.log.warn(
          `Unable to refresh Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, delayMs);
    unrefTimer(timer);
  }

  updateMetadata(device: RoborockDevice): void {
    const duid = device.duid;
    const displayName =
      this.api.getVacuumDeviceInfo(duid, "name") ||
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
    } else {
      delete this.accessory.firmwareRevision;
    }
    // Mutate the context instead of replacing it: Homebridge (and our own
    // persistence helpers) hold a reference to this object, so swapping it
    // out would silently orphan previously persisted state.
    if (!this.accessory.context) {
      this.accessory.context = {};
    }
    this.accessory.context.duid = duid;
    this.accessory.clusters = this.buildClusters();
    this.accessory.handlers = this.buildHandlers();
    this.accessory.getState = async (cluster, attribute) => {
      const clusterState = this.buildCluster(cluster);
      return clusterState ? clusterState[attribute] : undefined;
    };
  }

  async notifyDeviceUpdater(id: string, data: unknown): Promise<void> {
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

  async updateMatterStateFromRoborock(): Promise<void> {
    if (!this.registered) {
      return;
    }

    const matter = this.platform.getMatterApi();
    if (!matter || typeof matter.updateAccessoryState !== "function") {
      return;
    }

    const clusters = this.buildClusters();
    const updated = await this.publishRoborockSnapshot(
      clusters,
      "Roborock state refresh"
    );
    if (updated) {
      const power = clusters.powerSource as Record<string, unknown> | undefined;
      const halfPercent = power?.batPercentRemaining;
      const batteryChanged =
        typeof halfPercent === "number" &&
        halfPercent !== this.lastLoggedBatteryHalfPercent;
      if (!this.initialPublishLogged || batteryChanged) {
        this.initialPublishLogged = true;
        if (typeof halfPercent === "number") {
          this.lastLoggedBatteryHalfPercent = halfPercent;
        }
        const opState = clusters.rvcOperationalState as
          | Record<string, unknown>
          | undefined;
        const runMode = clusters.rvcRunMode as
          | Record<string, unknown>
          | undefined;
        const cleanMode = clusters.rvcCleanMode as
          | Record<string, unknown>
          | undefined;
        this.platform.log.info(
          `Matter publish for ${this.accessory.context?.duid ?? this.accessory.UUID}: battery=${typeof halfPercent === "number" ? halfPercent / 2 + "%" : "n/a"}, operationalState=${opState?.operationalState ?? "n/a"}, runMode=${runMode?.currentMode ?? "n/a"}, cleanMode=${cleanMode?.currentMode ?? "n/a"}.`
        );
      }
      this.ensureMatterStateHeartbeat();
    }
  }

  private buildHandlers(): Record<string, Record<string, unknown>> {
    const handlers: Record<string, Record<string, unknown>> = {
      identify: {
        identify: async () => {
          await this.identifyVacuum();
        },
      },
      rvcRunMode: {
        changeToMode: async (request?: { newMode?: number }) => {
          await this.changeRunMode(request?.newMode);
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
        changeToMode: async (request?: { newMode?: number }) => {
          await this.changeCleanMode(request?.newMode);
        },
      };
    }

    if (this.isServiceAreaEnabled()) {
      handlers.serviceArea = {
        selectAreas: async (request?: { newAreas?: unknown }) => {
          return await this.selectServiceAreas(request?.newAreas);
        },
      };
    }

    return handlers;
  }

  private async identifyVacuum(): Promise<void> {
    await this.publishCurrentMatterState("Matter identify command", {
      clearOptimistic: true,
    });

    const findMe = this.api.find_me;
    if (typeof findMe !== "function") {
      this.platform.log.debug(
        `Matter identify requested for ${this.getVacuumName()}, but the Roborock API does not expose find_me.`
      );
      return;
    }

    try {
      await findMe.call(
        this.api,
        this.getDuid(),
        this.getMatterCommandOptions()
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to locate ${this.getVacuumName()} from Matter identify: ${this.getErrorMessage(error)}`
      );
    }

    await this.publishCurrentMatterState("Matter identify command complete", {
      clearOptimistic: true,
    });
  }

  private async changeRunMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();
    const duid = this.getDuid();

    this.platform.log.info(
      `Matter run mode request for ${name}: ${newMode ?? "unknown"}.`
    );

    if (newMode === RUN_MODE_CLEANING) {
      const selectedAreas = this.getSelectedServiceAreaSegments();
      if (selectedAreas.length > 0) {
        const selectedMapIds = this.getSelectedServiceAreaMapIds(selectedAreas);
        const targetMapId = selectedMapIds[0] ?? null;
        // Roborock can only clean room segments from one map at a time. Service
        // area selection already constrains this to a single map, so this only
        // guards an unexpected multi-map selection by cleaning the first map
        // instead of throwing out of the Matter command handler.
        const areasToClean =
          selectedMapIds.length > 1
            ? selectedAreas.filter((area) => area.mapId === targetMapId)
            : selectedAreas;
        if (selectedMapIds.length > 1) {
          this.platform.log.warn(
            `Matter requested room cleaning across multiple Roborock maps for ${name}; cleaning only the areas on map ${targetMapId}.`
          );
        }

        const selectedAreaNames = areasToClean.map((area) =>
          this.formatServiceAreaName(area)
        );
        this.platform.log.info(
          `Starting ${name} from Matter for selected service area(s): ${selectedAreaNames.join(", ")}.`
        );
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
          await this.api.app_segment_clean_by_ids(
            duid,
            areasToClean.map((area) => area.segmentId),
            this.getMatterCommandOptions()
          );
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
      this.beginFullCleanServiceAreaProgress();
      this.setAndScheduleOptimisticState(state, "start");
      this.dispatchRoborockMatterCommand("start", async () => {
        await this.applySelectedCleanModeIfNeeded();
        await this.api.app_start(duid, this.getMatterCommandOptions());
      });
      return;
    }

    if (newMode === RUN_MODE_IDLE) {
      this.platform.log.info(
        `Stopping ${name} from Matter. Use the Home/Dock action to dock intentionally.`
      );
      const state = {
        rvcRunMode: { currentMode: RUN_MODE_IDLE },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.STOPPED,
        },
      };
      this.setAndScheduleOptimisticState(state, "stop");
      this.dispatchRoborockMatterCommand("stop", () =>
        this.api.app_stop(duid, this.getMatterCommandOptions())
      );
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter run mode '${newMode}' for ${name}.`
    );
  }

  private async changeCleanMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();

    this.platform.log.info(
      `Matter clean mode request for ${name}: ${newMode ?? "unknown"}.`
    );

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

    this.platform.log.warn(
      `Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`
    );
  }

  private async pauseCleaning(): Promise<void> {
    const roborockState = this.getNumberStatus("state");
    const chargeStatus = this.getNumberStatus("charge_status");
    const currentOperationalState = this.getOperationalState(
      roborockState,
      chargeStatus
    );
    const looksIdle =
      this.isRoborockDockedOrCharging(roborockState, chargeStatus) ||
      (roborockState !== null &&
        !this.isInCleaningRunMode(currentOperationalState));

    // Always forward an explicit Matter pause to the robot. The cached snapshot
    // can lag or be overridden by a stale HomeData refresh while the robot is
    // really cleaning (issues #4 and #12), so hard-dropping the command based on
    // it silently failed real pauses. Pausing an already-stopped robot is a
    // harmless no-op, and the optimistic state self-corrects if it was idle.
    if (looksIdle) {
      this.platform.log.info(
        `Pausing ${this.getVacuumName()} from Matter despite an idle snapshot; the cached state may be stale.`
      );
    } else {
      this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter.`);
    }
    const state = {
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.PAUSED,
      },
    };
    this.setAndScheduleOptimisticState(state, "pause");
    this.dispatchRoborockMatterCommand("pause", () =>
      this.api.app_pause(this.getDuid(), this.getMatterCommandOptions())
    );
  }

  private async resumeCleaning(): Promise<void> {
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

  private async returnToDock(): Promise<void> {
    // Always forward an explicit Matter dock to the robot. As with pause, the
    // cached snapshot can lag or be overridden by a stale HomeData refresh while
    // the robot is really cleaning (issues #4 and #12); docking an already-docked
    // robot is a harmless no-op.
    if (this.isDockedOrChargingNow()) {
      this.platform.log.info(
        `Sending ${this.getVacuumName()} back to dock from Matter despite a docked snapshot; the cached state may be stale.`
      );
    } else {
      this.platform.log.info(
        `Sending ${this.getVacuumName()} back to dock from Matter.`
      );
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
    this.dispatchRoborockMatterCommand(
      "return to dock",
      () => this.api.app_charge(this.getDuid(), this.getMatterCommandOptions()),
      { retryReturnToDockIfStillActive: true }
    );
  }

  private scheduleMatterStateUpdate(
    reason: string,
    optimisticGeneration?: number
  ): void {
    if (!this.registered) {
      return;
    }

    const timer = scheduleTimer(() => {
      if (
        optimisticGeneration !== undefined &&
        optimisticGeneration !== this.optimisticGeneration
      ) {
        this.platform.log.debug(
          `Skipping stale Matter optimistic state update after ${reason} for ${this.getVacuumName()}.`
        );
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
          this.platform.log.warn(
            `Unable to update Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
          );
        });
    }, 0);
    unrefTimer(timer);
  }

  private setAndScheduleOptimisticState(
    partialClusters: MatterClusterState,
    reason: string
  ): void {
    if (
      this.getNumberFromValue(
        partialClusters.rvcOperationalState?.operationalState
      ) === RVC_OPERATIONAL_STATE.RUNNING
    ) {
      // Remember when a start/resume/area-clean was issued so a follow-up pause
      // or dock is not dropped while the robot is still spinning up and the
      // cached snapshot lags behind (see RECENT_CLEANING_COMMAND_WINDOW_MS).
      this.lastCleaningCommandAt = Date.now();
    }
    const optimisticGeneration = this.setOptimisticState(
      partialClusters,
      reason
    );
    this.scheduleMatterStateUpdate(reason, optimisticGeneration);
  }

  private hasRecentlyCommandedCleaning(): boolean {
    return (
      Date.now() - this.lastCleaningCommandAt <
      RECENT_CLEANING_COMMAND_WINDOW_MS
    );
  }

  private async updateMatterState(
    partialClusters: Record<string, Record<string, unknown>>,
    reason = "state update"
  ): Promise<boolean> {
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
      const failures: unknown[] = [];
      await Promise.all(
        clusterEntries.map(async ([cluster, attributes]) => {
          try {
            await matter.updateAccessoryState(
              this.accessory.UUID,
              cluster,
              attributes
            );
            this.lastPublishedClusterJson.set(
              cluster,
              JSON.stringify(attributes)
            );
          } catch (error) {
            // Drop the record so the cluster is retried on the next snapshot
            // even if its payload is unchanged.
            this.lastPublishedClusterJson.delete(cluster);
            failures.push(error);
            this.platform.log.debug(
              `Matter publish for cluster ${cluster} on ${this.accessory.UUID} failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        })
      );
      if (failures.length > 0) {
        if (failures.length === clusterEntries.length) {
          throw failures[0];
        }
        // Partial failure: the surviving clusters have landed (that is the
        // isolation), but an initializing endpoint should still get its
        // retry so the failed cluster receives its value too.
        const initFailure = failures.find((failure) =>
          this.isMatterInitializingError(failure)
        );
        if (initFailure) {
          this.scheduleMatterInitializationRetry(reason, initFailure);
        }
      }
    });
    this.matterPublishChain = publishTask.then(
      () => undefined,
      () => undefined
    );

    try {
      await publishTask;
      this.matterInitializationRetryAttempt = 0;
      this.matterInitializationRetryPending = false;
      return true;
    } catch (error) {
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
  private async publishRoborockSnapshot(
    clusters: MatterClusterState,
    reason: string,
    options: { force?: boolean } = {}
  ): Promise<boolean> {
    // Skip clusters whose payload is byte-identical to the last confirmed
    // publish: every 15s poll and every heartbeat otherwise re-submits 4-6
    // unchanged clusters per robot through the Homebridge/matter.js stack.
    // The heartbeat passes force=true, keeping a periodic full write as the
    // self-healing safety net.
    if (options.force !== true) {
      const changed: MatterClusterState = {};
      for (const [cluster, attributes] of Object.entries(clusters)) {
        if (
          JSON.stringify(attributes) !==
          this.lastPublishedClusterJson.get(cluster)
        ) {
          changed[cluster] = attributes;
        }
      }
      if (Object.keys(changed).length === 0) {
        // Everything already published: a no-op is a successful publish.
        return true;
      }
      clusters = changed;
    }

    const power = clusters.powerSource as Record<string, unknown> | undefined;
    const resyncEligible =
      !this.powerSourceResyncDone &&
      power !== undefined &&
      typeof power.batPercentRemaining === "number";

    if (resyncEligible) {
      await this.updateMatterState(
        {
          powerSource: {
            ...power,
            batPercentRemaining: null,
            batChargeState: 0,
            batTimeToFullCharge: null,
          },
        },
        "Battery resync nudge"
      );
    }

    const updated = await this.updateMatterState(clusters, reason);
    if (updated && resyncEligible) {
      this.powerSourceResyncDone = true;
      this.platform.log.info(
        `Battery resync for ${this.accessory.context?.duid ?? this.accessory.UUID}: forced a fresh Matter attribute report (battery=${(power.batPercentRemaining as number) / 2}%).`
      );
    }

    return updated;
  }

  private async updateMatterStateFromMessage(data: unknown): Promise<void> {
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
    const fanPower = this.getNumberFromValue(status.fan_power);
    const matterCleanType = this.getNumberFromValue(status.matter_clean_type);

    if (
      state === null &&
      chargeStatus === null &&
      battery === null &&
      cleanArea === null &&
      cleanTime === null
    ) {
      return;
    }

    // Remember the freshest live values so a later full cluster rebuild reflects
    // them instead of the slower HomeData snapshot.
    const previousState = this.getNumberStatus("state");
    if (
      state !== null &&
      state !== ROOM_CLEAN_STATE &&
      state !== PAUSED_STATE
    ) {
      this.roomCleaningAreaConfirmed = false;
    } else if (
      state === ROOM_CLEAN_STATE &&
      previousState !== ROOM_CLEAN_STATE &&
      previousState !== PAUSED_STATE
    ) {
      this.roomCleaningAreaConfirmed = false;
    }

    this.rememberLiveStatus("state", state);
    this.rememberLiveStatus("charge_status", chargeStatus);
    this.rememberLiveStatus("battery", battery);
    this.rememberLiveStatus("clean_area", cleanArea);
    this.rememberLiveStatus("clean_time", cleanTime);
    // Fan power and clean type drive the live RvcCleanMode derivation, so
    // cleans (re)configured outside Apple Home surface within one update.
    this.rememberLiveStatus("fan_power", fanPower);
    this.rememberLiveStatus("matter_clean_type", matterCleanType);

    if (
      (state ?? previousState) === ROOM_CLEAN_STATE &&
      cleanArea !== null &&
      cleanTime !== null
    ) {
      this.roomCleaningAreaConfirmed = cleanArea > 0 && cleanTime > 0;
    }

    if (state !== null || chargeStatus !== null) {
      // Confirm or contradict any pending optimistic state. While optimism is
      // active the snapshot below still publishes the optimistic values, so no
      // separate suppression of the live values is needed.
      this.reconcileOptimisticStateWithLive(
        this.getOperationalState(state, chargeStatus),
        state,
        chargeStatus
      );
    }

    if (state !== null) {
      this.completeServiceAreaProgressIfDone(
        this.getOperationalState(state, chargeStatus)
      );
    }

    // Live map-position room tracking: reflect the physically detected room
    // in currentArea/progress before the snapshot below is built.
    const liveOperationalState = this.getOperationalState(
      this.getNumberStatus("state"),
      this.getNumberStatus("charge_status")
    );
    this.applyLiveServiceAreaRoom(liveOperationalState);
    this.driveLiveRoomTracking(liveOperationalState);

    const updated = await this.publishRoborockSnapshot(
      this.buildClusters(),
      "live state"
    );
    if (updated) {
      this.ensureMatterStateHeartbeat();
    }
  }

  private buildClusters(): MatterClusterState {
    const clusters: MatterClusterState = {
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

  private buildCluster(cluster: string): Record<string, unknown> | undefined {
    let clusterState: Record<string, unknown> | undefined;

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

    const optimisticCluster = this.getActiveOptimisticState()?.[cluster];
    return optimisticCluster
      ? { ...clusterState, ...optimisticCluster }
      : clusterState;
  }

  private buildRunModeCluster(): Record<string, unknown> {
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

  private buildCleanModeCluster(): Record<string, unknown> {
    return {
      supportedModes: this.getSupportedCleanModes(),
      currentMode: this.getCurrentCleanMode(),
    };
  }

  private getSupportedCleanModes(): Array<Record<string, unknown>> {
    const supportedModes: Array<Record<string, unknown>> = [
      {
        label: "Vacuum",
        mode: CLEAN_MODE_VACUUM,
        modeTags: [{ value: RVC_CLEAN_MODE_TAG_VACUUM }],
      },
    ];

    const capabilities = this.getMatterCleanModeCapabilities();
    if (capabilities.canMop) {
      supportedModes.push(
        {
          label: "Mop",
          mode: CLEAN_MODE_MOP,
          modeTags: [{ value: RVC_CLEAN_MODE_TAG_MOP }],
        },
        {
          // Matter has no dedicated "vacuum then mop" tag, so combine the two
          // standard RVC Clean Mode tags instead of an undefined tag value.
          label: "Vacuum + Mop",
          mode: CLEAN_MODE_VACUUM_AND_MOP,
          modeTags: [
            { value: RVC_CLEAN_MODE_TAG_VACUUM },
            { value: RVC_CLEAN_MODE_TAG_MOP },
          ],
        }
      );
    }

    // Opt-in suction-level variants, only when the robot actually exposes
    // fan-power control. NOTE: Matter fixes the announced mode set at
    // commissioning — toggling this option requires re-pairing the robot.
    if (
      this.isFanPowerCleanModesEnabled() &&
      capabilities.canControlFanPower === true
    ) {
      const powerModes =
        capabilities.canMaxPlusFanPower === true
          ? [...FAN_POWER_CLEAN_MODES, MAX_PLUS_FAN_POWER_CLEAN_MODE]
          : FAN_POWER_CLEAN_MODES;
      for (const powerMode of powerModes) {
        supportedModes.push({
          label: powerMode.label,
          mode: powerMode.mode,
          modeTags: [
            { value: RVC_CLEAN_MODE_TAG_VACUUM },
            ...powerMode.extraTags.map((value) => ({ value })),
          ],
        });
      }
    }

    return supportedModes;
  }

  private isFanPowerCleanModesEnabled(): boolean {
    return this.platform.platformConfig.enableFanPowerCleanModes === true;
  }

  private getFanPowerCleanMode(
    cleanMode: number
  ): (typeof FAN_POWER_CLEAN_MODES)[number] | null {
    if (cleanMode === MAX_PLUS_FAN_POWER_CLEAN_MODE.mode) {
      return MAX_PLUS_FAN_POWER_CLEAN_MODE;
    }
    return (
      FAN_POWER_CLEAN_MODES.find((powerMode) => powerMode.mode === cleanMode) ??
      null
    );
  }

  private getCurrentCleanMode(): number {
    let selected = this.isSupportedCleanMode(this.selectedCleanMode)
      ? this.selectedCleanMode
      : CLEAN_MODE_VACUUM;

    // Live clean-type derivation during an active run: cleans started from
    // the Roborock app or the robot's own buttons carry their own clean type
    // (vacuum / mop / vacuum+mop), so report what the robot is ACTUALLY
    // doing instead of the last Matter selection. B01/Q7 robots report the
    // type directly; classic robots are derived from the mop-only fan power
    // signature and the active water-flow setting. A pending Matter
    // selection wins until it has been applied, and outside an active run
    // the (sticky) robot-side setting must not shadow the user's selection.
    if (
      !this.selectedCleanModeNeedsApply &&
      this.isInCleaningRunMode(this.getOperationalState())
    ) {
      const liveCleanType = this.getLiveCleanType();
      if (liveCleanType !== null && this.isSupportedCleanMode(liveCleanType)) {
        if (liveCleanType !== CLEAN_MODE_VACUUM) {
          return liveCleanType;
        }
        // Vacuum-family: fall through so the fan-power refinement below can
        // pick the matching suction variant when those modes are announced.
        selected = CLEAN_MODE_VACUUM;
      }
    }

    // Live derivation while suction-level modes are announced: report the
    // variant matching the robot's ACTUAL fan power, so suction changed in
    // the Roborock app is reflected in Apple Home's mode picker. A pending
    // Matter selection wins until it has been applied, and mop-family
    // selections are never overridden (their identity is the clean type,
    // not the fan level).
    if (
      this.isFanPowerCleanModesEnabled() &&
      !this.selectedCleanModeNeedsApply &&
      selected !== CLEAN_MODE_MOP &&
      selected !== CLEAN_MODE_VACUUM_AND_MOP
    ) {
      const liveFanPower = this.getNumberStatus("fan_power");
      if (liveFanPower !== null) {
        const liveMode =
          liveFanPower === MAX_PLUS_FAN_POWER_CLEAN_MODE.fanPower
            ? MAX_PLUS_FAN_POWER_CLEAN_MODE
            : FAN_POWER_CLEAN_MODES.find(
                (powerMode) => powerMode.fanPower === liveFanPower
              );
        if (liveMode && this.isSupportedCleanMode(liveMode.mode)) {
          return liveMode.mode;
        }
      }
    }

    return selected;
  }

  /**
   * The clean type the robot itself reports for the CURRENT run, translated
   * to the Matter clean-mode id, or null when the robot gives no signal.
   * B01/Q7: reported directly (`mode` property in every status poll).
   * Classic v1: fan power 105 ("off") is the mop-only signature; otherwise an
   * active water-flow setting on a mop-capable robot means vacuum+mop.
   */
  private getLiveCleanType(): number | null {
    const reported = this.getNumberStatus("matter_clean_type");
    if (reported !== null) {
      return reported;
    }

    const fanPower = this.getNumberStatus("fan_power");
    if (fanPower === ROBOROCK_FAN_POWER_OFF) {
      return CLEAN_MODE_MOP;
    }

    if (!this.getMatterCleanModeCapabilities().canControlWater) {
      // Without water-flow control there is no reliable mop signal; robots
      // like mop-less models must not be guessed into a mop mode.
      return null;
    }

    const waterBoxMode =
      this.getNumberStatus("water_box_custom_mode") ??
      this.getNumberStatus("water_box_mode");
    if (waterBoxMode === null) {
      return null;
    }

    return waterBoxMode !== ROBOROCK_WATER_BOX_OFF
      ? CLEAN_MODE_VACUUM_AND_MOP
      : CLEAN_MODE_VACUUM;
  }

  private isSupportedCleanMode(mode?: number): mode is number {
    return this.getSupportedCleanModes().some(
      (supportedMode) => supportedMode.mode === mode
    );
  }

  private getMatterCleanModeCapabilities(): MatterCleanModeCapabilities {
    const getCapabilities = this.api.getMatterCleanModeCapabilities;

    if (typeof getCapabilities !== "function") {
      return { canVacuum: true, canMop: false };
    }

    // Guard against older/patched API builds returning undefined so cluster
    // builds (which run inside Matter attribute reads) can never throw.
    const capabilities = getCapabilities.call(this.api, this.getDuid()) as
      | MatterCleanModeCapabilities
      | null
      | undefined;

    return capabilities ?? { canVacuum: true, canMop: false };
  }

  private async applySelectedCleanModeIfNeeded(): Promise<void> {
    if (!this.selectedCleanModeNeedsApply) {
      return;
    }

    const applySettings = this.api.applyMatterCleanModeSettings;
    if (typeof applySettings !== "function") {
      this.selectedCleanModeNeedsApply = false;
      return;
    }

    const settings = this.getRoborockCleanModeSettings(
      this.getCurrentCleanMode()
    );
    if (!settings) {
      this.selectedCleanModeNeedsApply = false;
      return;
    }

    this.platform.log.info(
      `Applying ${this.getCleanModeLabel(this.getCurrentCleanMode())} mode to ${this.getVacuumName()} before starting.`
    );
    try {
      await this.withCleanModePrepTimeout(
        applySettings.call(
          this.api,
          this.getDuid(),
          settings,
          this.getMatterCleanModePrepCommandOptions()
        )
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to apply ${this.getCleanModeLabel(this.getCurrentCleanMode())} mode to ${this.getVacuumName()} before starting; continuing with the start command. ${this.getErrorMessage(error)}`
      );
    } finally {
      this.selectedCleanModeNeedsApply = false;
    }
  }

  private async withCleanModePrepTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof nodeSetTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = scheduleTimer(() => {
        reject(
          new Error(
            `Matter clean mode prep timed out after ${MATTER_CLEAN_MODE_PREP_TIMEOUT_MS} ms.`
          )
        );
      }, MATTER_CLEAN_MODE_PREP_TIMEOUT_MS);
      unrefTimer(timeout);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimer(timeout);
      }
    }
  }

  private getRoborockCleanModeSettings(
    cleanMode: number
  ): RoborockCleanModeSettings | null {
    const capabilities = this.getMatterCleanModeCapabilities();
    // Fan-power variants are vacuum-family modes with a pinned suction
    // level: protocol layers only understand the three base clean types, so
    // translate before handing over.
    const fanPowerMode = this.getFanPowerCleanMode(cleanMode);
    const baseCleanMode = fanPowerMode ? CLEAN_MODE_VACUUM : cleanMode;

    // Always carry the selected Matter clean mode; protocol layers that have
    // a native clean-type concept (B01/Q7) apply it directly and ignore the
    // v1-style fan/water workarounds below.
    const settings: RoborockCleanModeSettings = { cleanMode: baseCleanMode };

    if (capabilities.canControlFanPower) {
      settings.fanPower = fanPowerMode
        ? fanPowerMode.fanPower
        : baseCleanMode === CLEAN_MODE_MOP
          ? ROBOROCK_FAN_POWER_OFF
          : this.getPreferredVacuumFanPower();
    }

    if (capabilities.canControlWater) {
      settings.waterBoxMode =
        baseCleanMode === CLEAN_MODE_VACUUM
          ? ROBOROCK_WATER_BOX_OFF
          : this.getPreferredWaterBoxMode();
    }

    return Object.keys(settings).length > 0 ? settings : null;
  }

  private rememberCurrentRoborockCleanModeSettings(): void {
    const fanPower = this.getNumberStatus("fan_power");
    if (fanPower !== null && fanPower !== ROBOROCK_FAN_POWER_OFF) {
      this.lastVacuumFanPower = fanPower;
    }

    const waterBoxMode = this.getWaterBoxModeStatus();
    if (waterBoxMode !== null && waterBoxMode !== ROBOROCK_WATER_BOX_OFF) {
      this.lastWaterBoxMode = waterBoxMode;
    }
  }

  private getPreferredVacuumFanPower(): number {
    const currentFanPower = this.getNumberStatus("fan_power");
    if (
      currentFanPower !== null &&
      currentFanPower !== ROBOROCK_FAN_POWER_OFF
    ) {
      this.lastVacuumFanPower = currentFanPower;
      return currentFanPower;
    }

    return this.lastVacuumFanPower ?? ROBOROCK_FAN_POWER_BALANCED;
  }

  private getWaterBoxModeStatus(): number | null {
    return (
      this.getNumberStatus("water_box_custom_mode") ??
      this.getNumberStatus("water_box_mode")
    );
  }

  private getPreferredWaterBoxMode(): number {
    const currentWaterBoxMode = this.getWaterBoxModeStatus();
    if (
      currentWaterBoxMode !== null &&
      currentWaterBoxMode !== ROBOROCK_WATER_BOX_OFF
    ) {
      this.lastWaterBoxMode = currentWaterBoxMode;
      return currentWaterBoxMode;
    }

    return this.lastWaterBoxMode ?? ROBOROCK_WATER_BOX_MILD;
  }

  private getCleanModeLabel(cleanMode: number): string {
    const fanPowerMode = this.getFanPowerCleanMode(cleanMode);
    if (fanPowerMode) {
      return fanPowerMode.label;
    }
    switch (cleanMode) {
      case CLEAN_MODE_MOP:
        return "Mop";
      case CLEAN_MODE_VACUUM_AND_MOP:
        return "Vacuum + Mop";
      default:
        return "Vacuum";
    }
  }

  private buildOperationalStateCluster(): Record<string, unknown> {
    const operationalState = this.getOperationalState();

    return {
      // RVC Operational State requires PhaseList and CurrentPhase to be null.
      phaseList: null,
      currentPhase: null,
      // Advertise operational state IDs without labels. Apple Home stops
      // commissioning ("Connecting" forever) when the list carries labels or
      // manufacturer-range IDs, so only bare IDs are exposed here.
      operationalStateList: this.getOperationalStateList().map(
        (operationalStateId) => ({ operationalStateId })
      ),
      operationalState,
    };
  }

  private buildPowerSourceCluster(
    batteryValue?: number,
    chargeStatusValue?: number | null,
    stateValue?: number | null
  ): Record<string, unknown> {
    const battery =
      batteryValue === undefined
        ? this.getNumberStatus("battery")
        : batteryValue;
    const chargeStatus =
      chargeStatusValue === undefined
        ? this.getNumberStatus("charge_status")
        : chargeStatusValue;
    const state =
      stateValue === undefined ? this.getNumberStatus("state") : stateValue;
    const normalizedBattery =
      battery === null ? null : Math.max(0, Math.min(100, battery));
    const batChargeState = this.getBatteryChargeState(
      normalizedBattery,
      chargeStatus,
      state
    );

    return {
      status:
        normalizedBattery === null
          ? POWER_SOURCE_STATUS.UNAVAILABLE
          : POWER_SOURCE_STATUS.ACTIVE,
      order: 0,
      description: "Roborock vacuum battery",
      batPresent: normalizedBattery !== null,
      batPercentRemaining:
        normalizedBattery === null ? null : normalizedBattery * 2,
      batChargeLevel: this.getBatteryChargeLevel(normalizedBattery),
      batChargeState,
      batReplacementNeeded: false,
      batReplaceability: BATTERY_REPLACEABILITY.UNSPECIFIED,
      batFunctionalWhileCharging: true,
      batTimeToFullCharge: this.getBatteryTimeToFullCharge(
        normalizedBattery,
        batChargeState
      ),
      batChargingCurrent: null,
    };
  }

  private addPowerSourceCluster(
    clusters: MatterClusterState,
    batteryValue?: number,
    chargeStatusValue?: number | null,
    stateValue?: number | null
  ): void {
    if (!this.isPowerSourceEnabled()) {
      return;
    }

    clusters.powerSource = this.buildPowerSourceCluster(
      batteryValue,
      chargeStatusValue,
      stateValue
    );
  }

  private addCleanModeCluster(clusters: MatterClusterState): void {
    if (!this.isCleanModeEnabled()) {
      return;
    }

    clusters.rvcCleanMode = this.buildCleanModeCluster();
  }

  private hasServiceAreasToExpose(): boolean {
    return this.getMatterServiceAreas().length > 0;
  }

  private persistServiceAreaProgress(): void {
    // Best-effort: Homebridge persists accessory context periodically and on
    // shutdown, so a restart mid-clean restores the room display instead of
    // silently dropping back to a generic label.
    this.accessory.context.serviceAreaProgressState = {
      currentArea: this.serviceAreaCurrentArea,
      progress: this.serviceAreaProgress.map((entry) => ({ ...entry })),
    };
  }

  private restoreServiceAreaProgress(): void {
    const persisted = this.accessory.context?.serviceAreaProgressState as
      | { currentArea?: unknown; progress?: unknown }
      | undefined;
    if (!persisted || !Array.isArray(persisted.progress)) {
      return;
    }
    this.serviceAreaCurrentArea =
      typeof persisted.currentArea === "number" ? persisted.currentArea : null;
    this.serviceAreaProgress = persisted.progress
      .filter(
        (entry: unknown): entry is { areaId: number; status: number } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { areaId?: unknown }).areaId === "number" &&
          typeof (entry as { status?: unknown }).status === "number"
      )
      .map((entry: { areaId: number; status: number }) => ({ ...entry }));
  }

  private beginServiceAreaProgress(areaIds: number[]): void {
    if (areaIds.length === 0) {
      this.clearServiceAreaProgress();
      return;
    }
    // We know which rooms were requested; until live map-position tracking
    // reports which one the robot is actually inside, the first requested
    // area is shown as operating and the rest as pending.
    this.liveConfirmedServiceAreaIds = new Set();
    this.serviceAreaCurrentArea = areaIds[0];
    this.serviceAreaProgress = areaIds.map((areaId, index) => ({
      areaId,
      status:
        index === 0
          ? SERVICE_AREA_PROGRESS.OPERATING
          : SERVICE_AREA_PROGRESS.PENDING,
    }));
    this.persistServiceAreaProgress();
  }

  /**
   * A full-home clean operates on every supported area. We cannot know which
   * room the robot is physically inside (the robots do not report it), so no
   * area is marked operating and currentArea stays null — but publishing the
   * run's scope as pending -> completed gives controllers real progress data
   * instead of an empty list, which Apple Home otherwise renders as a
   * permanent "Preparing".
   */
  private beginFullCleanServiceAreaProgress(): void {
    const areaIds = this.getMatterServiceAreas().map((area) => area.areaId);
    if (areaIds.length === 0) {
      this.clearServiceAreaProgress();
      return;
    }
    this.liveConfirmedServiceAreaIds = new Set();
    this.serviceAreaCurrentArea = null;
    this.serviceAreaProgress = areaIds.map((areaId) => ({
      areaId,
      status: SERVICE_AREA_PROGRESS.PENDING,
    }));
    this.persistServiceAreaProgress();
  }

  private clearServiceAreaProgress(): void {
    this.liveConfirmedServiceAreaIds = new Set();
    this.serviceAreaCurrentArea = null;
    this.serviceAreaProgress = [];
    this.persistServiceAreaProgress();
  }

  private completeServiceAreaProgressIfDone(operationalState: number): void {
    if (this.serviceAreaProgress.length === 0) {
      return;
    }
    if (this.isInCleaningRunMode(operationalState)) {
      return;
    }
    // The run ended (docked, charging, stopped): everything requested is
    // reported as completed and no area is current anymore.
    this.liveConfirmedServiceAreaIds = new Set();
    this.serviceAreaCurrentArea = null;
    this.serviceAreaProgress = this.serviceAreaProgress.map((entry) => ({
      areaId: entry.areaId,
      status: SERVICE_AREA_PROGRESS.COMPLETED,
    }));
    this.persistServiceAreaProgress();
  }

  /**
   * Apply the live map-position room (B01/Q7: SCMap currentPose ray-cast
   * against room outlines, refreshed by the Roborock API layer while the
   * robot is actively cleaning) to the Service Area state.
   *
   * currentArea always follows the physically detected room — that is the
   * honest signal controllers render as "cleaning in <room>". The progress
   * list only transitions entries that are part of the announced run scope:
   * the detected room's entry becomes operating, and a previously operating
   * scoped entry becomes completed once the robot is detected in a DIFFERENT
   * scoped room — but only if the robot was actually detected inside it at
   * some point (otherwise it was just the initial first-requested guess and
   * honestly returns to pending). Stale all-completed lists from a finished
   * run are never mutated.
   */
  /**
   * Ask the API layer to refresh the live room while a cleaning run is
   * active (it throttles and single-flights internally; B01 robots are
   * additionally driven by their own status loop), and clear the cached
   * room once the run is over so stale rooms never leak into the next one.
   */
  private driveLiveRoomTracking(operationalState: number): void {
    if (!this.isServiceAreaEnabled()) {
      return;
    }
    const apiWithLiveRoom = this.api as {
      refreshLiveRoomForDevice?: (
        duid: string,
        context: { v1State: number | null }
      ) => Promise<unknown>;
      clearLiveRoomForDevice?: (duid: string) => void;
    };

    if (this.isInCleaningRunMode(operationalState)) {
      if (typeof apiWithLiveRoom.refreshLiveRoomForDevice === "function") {
        void apiWithLiveRoom.refreshLiveRoomForDevice
          .call(this.api, this.getDuid(), {
            v1State: this.getNumberStatus("state"),
          })
          .catch(() => undefined);
      }
    } else if (typeof apiWithLiveRoom.clearLiveRoomForDevice === "function") {
      // Run over (docked/charging/stopped/error): drop the cached room.
      apiWithLiveRoom.clearLiveRoomForDevice.call(this.api, this.getDuid());
    }
  }

  private applyLiveServiceAreaRoom(operationalState: number): void {
    if (!this.isServiceAreaEnabled()) {
      return;
    }
    if (!this.isInCleaningRunMode(operationalState)) {
      return;
    }

    const apiWithLiveRoom = this.api as {
      getLiveRoomForDevice?: (duid: string) => unknown;
      getB01LiveRoomForDevice?: (duid: string) => unknown;
    };
    // Protocol-agnostic getter (B01 + classic v1); the B01-specific getter
    // remains as a fallback for older API surfaces.
    const getLiveRoom =
      apiWithLiveRoom.getLiveRoomForDevice ??
      apiWithLiveRoom.getB01LiveRoomForDevice;
    if (typeof getLiveRoom !== "function") {
      return;
    }

    const liveRoom = this.asRecord(getLiveRoom.call(this.api, this.getDuid()));
    const segmentId = this.getNumberFromValue(liveRoom?.segmentId);
    if (segmentId === null) {
      return;
    }

    const area = this.getMatterServiceAreas().find(
      (candidate) => candidate.segmentId === segmentId
    );
    if (!area) {
      return;
    }

    const changedCurrentArea = this.serviceAreaCurrentArea !== area.areaId;
    const previousAreaId = this.serviceAreaCurrentArea;

    const hasActiveScope = this.serviceAreaProgress.some(
      (entry) => entry.status !== SERVICE_AREA_PROGRESS.COMPLETED
    );
    const detectedEntryInScope = this.serviceAreaProgress.some(
      (entry) => entry.areaId === area.areaId
    );

    let changedProgress = false;
    if (hasActiveScope && detectedEntryInScope) {
      this.serviceAreaProgress = this.serviceAreaProgress.map((entry) => {
        if (
          entry.areaId === area.areaId &&
          entry.status !== SERVICE_AREA_PROGRESS.OPERATING
        ) {
          changedProgress = true;
          return {
            areaId: entry.areaId,
            status: SERVICE_AREA_PROGRESS.OPERATING,
          };
        }
        if (
          entry.areaId !== area.areaId &&
          entry.status === SERVICE_AREA_PROGRESS.OPERATING
        ) {
          changedProgress = true;
          return {
            areaId: entry.areaId,
            status: this.liveConfirmedServiceAreaIds.has(entry.areaId)
              ? SERVICE_AREA_PROGRESS.COMPLETED
              : SERVICE_AREA_PROGRESS.PENDING,
          };
        }
        return entry;
      });
    }

    this.liveConfirmedServiceAreaIds.add(area.areaId);
    if (!changedCurrentArea && !changedProgress) {
      return;
    }

    this.serviceAreaCurrentArea = area.areaId;
    this.persistServiceAreaProgress();
    if (changedCurrentArea) {
      this.platform.log.info(
        `Live room for ${this.getVacuumName()}: robot detected in ${this.formatServiceAreaName(area)}${
          previousAreaId !== null ? "" : " (first detection this run)"
        }.`
      );
    }
  }

  private buildServiceAreaCluster(): Record<string, unknown> {
    const areas = this.getMatterServiceAreas();
    const supportedMaps = this.getMatterServiceAreaMaps(areas);
    const includeMapNamesInAreaLabels = supportedMaps.length > 1;
    const supportedAreaIds = new Set(areas.map((area) => area.areaId));
    const selectedAreas = this.selectedServiceAreaIds.filter((areaId) =>
      supportedAreaIds.has(areaId)
    );

    if (selectedAreas.length !== this.selectedServiceAreaIds.length) {
      this.selectedServiceAreaIds = selectedAreas;
    }

    this.logMatterServiceAreaSummary(areas, supportedMaps);

    const state: Record<string, unknown> = {
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
            locationName: this.getMatterLocationDisplayName(
              area,
              includeMapNamesInAreaLabels
            ),
            floorNumber: null,
            areaType: null,
          },
          landmarkInfo: null,
        },
      })),
      selectedAreas,
      currentArea:
        this.serviceAreaCurrentArea ??
        this.getCurrentServiceArea(selectedAreas),
    };

    if (supportedMaps.length > 0) {
      state.supportedMaps = supportedMaps;
    }

    return state;
  }

  private getCurrentServiceArea(selectedAreas: number[]): number | null {
    if (selectedAreas.length !== 1 || !this.roomCleaningAreaConfirmed) {
      return null;
    }

    const state = this.getNumberStatus("state");
    return state === ROOM_CLEAN_STATE || state === PAUSED_STATE
      ? selectedAreas[0]
      : null;
  }

  private async selectServiceAreas(
    newAreas?: unknown
  ): Promise<Record<string, unknown>> {
    const supportedAreas = new Map(
      this.getMatterServiceAreas().map((area) => [area.areaId, area])
    );
    const selectedAreas = this.normalizeMatterAreaIds(newAreas);
    const unsupportedArea = selectedAreas.find(
      (areaId) => !supportedAreas.has(areaId)
    );

    this.platform.log.info(
      `Matter service area selection request for ${this.getVacuumName()}: ${selectedAreas.join(", ") || "none"}.`
    );

    if (unsupportedArea !== undefined) {
      return {
        status: SERVICE_AREA_SELECT_STATUS.UNSUPPORTED_AREA,
        statusText: `Area ${unsupportedArea} is not available from the Roborock room map.`,
      };
    }

    const selectedMapIds = this.getSelectedServiceAreaMapIds(
      selectedAreas
        .map((areaId) => supportedAreas.get(areaId))
        .filter((area): area is MatterServiceArea => area !== undefined)
    );
    if (selectedMapIds.length > 1) {
      this.platform.log.warn(
        `Ignoring Matter service area selection spanning multiple Roborock maps for ${this.getVacuumName()}; select areas from one map at a time.`
      );
      return {
        status: SERVICE_AREA_SELECT_STATUS.INVALID_SET,
        statusText:
          "Select service areas from only one Roborock map at a time.",
      };
    }

    this.selectedServiceAreaIds = selectedAreas;
    if (selectedAreas.length > 0) {
      const areaNames = selectedAreas
        .map((areaId) => supportedAreas.get(areaId))
        .filter((area): area is MatterServiceArea => area !== undefined)
        .map((area) => this.formatServiceAreaName(area));
      this.platform.log.info(
        `Selected Matter service area(s) for ${this.getVacuumName()}: ${areaNames.join(", ")}.`
      );
    } else {
      this.platform.log.info(
        `Cleared Matter service area selection for ${this.getVacuumName()}.`
      );
    }

    // Defer the publish so the selectAreas handler returns promptly; the
    // snapshot is rebuilt at execution time from the stored selection.
    const publishTimer = scheduleTimer(() => {
      void this.updateMatterState(
        this.buildClusters(),
        "service area selection"
      ).catch((error) => {
        this.platform.log.warn(
          `Unable to update Matter service area selection for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, 0);
    unrefTimer(publishTimer);

    return {
      status: SERVICE_AREA_SELECT_STATUS.SUCCESS,
      statusText: "",
    };
  }

  private getMatterServiceAreas(): MatterServiceArea[] {
    const getRoomMappingsForDevice = this.api.getRoomMappingsForDevice;
    if (typeof getRoomMappingsForDevice !== "function") {
      return [];
    }

    const rooms = getRoomMappingsForDevice.call(this.api, this.getDuid());
    if (!Array.isArray(rooms)) {
      return [];
    }

    const areas: MatterServiceArea[] = [];
    const mapsById = new Map(
      this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map])
    );
    const seenAreaIds = new Set<number>();
    for (const room of rooms) {
      const roomRecord = this.asRecord(room);
      const segmentId = this.getNumberFromValue(roomRecord?.segmentId);
      const mapId = this.getMatterMapId(roomRecord?.mapId);
      const areaId =
        segmentId === null
          ? null
          : this.getMatterAreaId(segmentId, mapId, seenAreaIds);
      if (
        areaId === null ||
        segmentId === null ||
        !Number.isInteger(segmentId) ||
        segmentId < 0 ||
        seenAreaIds.has(areaId)
      ) {
        continue;
      }

      seenAreaIds.add(areaId);
      areas.push({
        areaId,
        segmentId,
        mapId,
        mapName: mapId === null ? null : mapsById.get(mapId)?.name || null,
        name: this.toMatterLocationName(roomRecord?.name, segmentId),
      });
    }

    return areas;
  }

  private getMatterServiceAreaMaps(
    areas: MatterServiceArea[]
  ): MatterServiceAreaMap[] {
    // Matter controllers can hang if supportedMaps advertises maps with no
    // matching supportedAreas, or if supportedAreas reference a mapId that has
    // no supportedMaps entry. Build supportedMaps from exactly the maps that
    // have areas, preferring Roborock-reported map names and falling back to
    // the area's map name or a generated label.
    const roborockMapsById = new Map(
      this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map])
    );

    const maps: MatterServiceAreaMap[] = [];
    const seenMapIds = new Set<number>();

    for (const area of areas) {
      if (area.mapId === null || seenMapIds.has(area.mapId)) {
        continue;
      }

      seenMapIds.add(area.mapId);
      maps.push({
        mapId: area.mapId,
        name:
          roborockMapsById.get(area.mapId)?.name ||
          area.mapName ||
          `Roborock Map ${area.mapId}`,
      });
    }

    return maps;
  }

  private getMatterServiceAreaMapsFromRoborock(): MatterServiceAreaMap[] {
    const getMapListForDevice = this.api.getMapListForDevice;
    if (typeof getMapListForDevice !== "function") {
      return [];
    }

    const maps = getMapListForDevice.call(this.api, this.getDuid());
    if (!Array.isArray(maps)) {
      return [];
    }

    const supportedMaps: MatterServiceAreaMap[] = [];
    const seenMapIds = new Set<number>();
    for (const map of maps) {
      const mapRecord = this.asRecord(map);
      const mapId = this.getMatterMapId(mapRecord?.mapId);
      if (mapId === null || seenMapIds.has(mapId)) {
        continue;
      }

      seenMapIds.add(mapId);
      supportedMaps.push({
        mapId,
        name: this.toMatterMapName(mapRecord?.name, mapId),
      });
    }

    return supportedMaps;
  }

  private getMatterAreaId(
    segmentId: number,
    mapId: number | null,
    usedAreaIds: Set<number>
  ): number {
    let areaId =
      mapId === null
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

  private getHashedMatterAreaId(
    mapId: number | null,
    segmentId: number
  ): number {
    const source = `${mapId ?? "none"}:${segmentId}`;
    let hash = 2166136261;

    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    return hash;
  }

  private getMatterMapId(value: unknown): number | null {
    const mapId = this.getNumberFromValue(value);

    return mapId !== null && Number.isInteger(mapId) && mapId >= 0
      ? mapId
      : null;
  }

  private logMatterServiceAreaSummary(
    areas: MatterServiceArea[],
    maps: MatterServiceAreaMap[]
  ): void {
    const summary = [
      this.getDuid(),
      areas
        .map((area) => `${area.areaId}:${area.mapId ?? "none"}:${area.name}`)
        .join("|"),
      maps.map((map) => `${map.mapId}:${map.name}`).join("|"),
    ].join(";");

    if (summary === this.lastServiceAreaSummary) {
      return;
    }

    this.lastServiceAreaSummary = summary;

    if (areas.length === 0) {
      this.platform.log.info(
        `Matter Service Area is enabled for ${this.getVacuumName()}, but no Roborock rooms are available to expose yet.`
      );
      return;
    }

    this.platform.log.info(
      `Matter Service Area for ${this.getVacuumName()}: exposing ${areas.length} room(s)` +
        `${maps.length > 0 ? ` on ${maps.length} map(s)` : ""}: ${areas
          .map((area) =>
            this.getMatterLocationDisplayName(area, maps.length > 1)
          )
          .join(", ")}.`
    );
  }

  private getSelectedServiceAreaSegments(): MatterServiceArea[] {
    if (!this.isServiceAreaEnabled()) {
      return [];
    }

    const areasById = new Map(
      this.getMatterServiceAreas().map((area) => [area.areaId, area])
    );
    return this.selectedServiceAreaIds
      .map((areaId) => areasById.get(areaId))
      .filter((area): area is MatterServiceArea => area !== undefined);
  }

  private normalizeMatterAreaIds(newAreas: unknown): number[] {
    if (!Array.isArray(newAreas)) {
      return [];
    }

    const selectedAreas: number[] = [];
    const seenAreaIds = new Set<number>();
    for (const area of newAreas) {
      const areaId = this.getNumberFromValue(area);
      if (
        areaId === null ||
        !Number.isInteger(areaId) ||
        areaId < 0 ||
        seenAreaIds.has(areaId)
      ) {
        continue;
      }

      seenAreaIds.add(areaId);
      selectedAreas.push(areaId);
    }

    return selectedAreas;
  }

  private clampMatterName(
    name: unknown,
    maxLength: number,
    fallback: string
  ): string {
    const normalizedName =
      typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    const value = normalizedName || fallback;

    return value.length > maxLength
      ? value.slice(0, maxLength).trim() || fallback
      : value;
  }

  private toMatterLocationName(name: unknown, areaId: number): string {
    return this.clampMatterName(
      name,
      MATTER_LOCATION_NAME_MAX_LENGTH,
      `Room ${areaId}`
    );
  }

  private toMatterMapName(name: unknown, mapId: number): string {
    return this.clampMatterName(
      name,
      MATTER_MAP_NAME_MAX_LENGTH,
      `Roborock Map ${mapId}`
    );
  }

  private formatServiceAreaName(area: MatterServiceArea): string {
    return area.mapName ? `${area.name} (${area.mapName})` : area.name;
  }

  private getMatterLocationDisplayName(
    area: MatterServiceArea,
    includeMapName: boolean
  ): string {
    if (!includeMapName || !area.mapName) {
      return area.name;
    }

    const fallbackName = this.clampMatterName(
      `${area.mapName} - Room ${area.segmentId}`,
      MATTER_LOCATION_NAME_MAX_LENGTH,
      area.name
    );

    return this.clampMatterName(
      `${area.mapName} - ${area.name}`,
      MATTER_LOCATION_NAME_MAX_LENGTH,
      fallbackName
    );
  }

  private getSelectedServiceAreaMapIds(
    selectedAreas: MatterServiceArea[]
  ): number[] {
    const selectedMapIds = new Set<number>();
    for (const area of selectedAreas) {
      if (area.mapId !== null) {
        selectedMapIds.add(area.mapId);
      }
    }

    return Array.from(selectedMapIds);
  }

  private async loadMatterMapIfNeeded(
    duid: string,
    targetMapId: number | null
  ): Promise<void> {
    if (targetMapId === null) {
      return;
    }

    const currentMapId = this.getCurrentMatterMapId();
    if (currentMapId === targetMapId) {
      return;
    }

    const loadMap = this.api.load_multi_map;
    if (typeof loadMap !== "function") {
      throw new Error(
        `Roborock map ${targetMapId} is not currently loaded and this plugin cannot switch maps.`
      );
    }

    this.platform.log.info(
      `Loading Roborock map ${targetMapId} for ${this.getVacuumName()} before selected-area cleaning.`
    );
    try {
      await loadMap.call(
        this.api,
        duid,
        targetMapId,
        this.getMatterMapLoadCommandOptions()
      );
    } catch (error) {
      const currentMapIdAfterError = this.getCurrentMatterMapId();
      if (currentMapIdAfterError === targetMapId) {
        this.platform.log.warn(
          `Roborock map ${targetMapId} for ${this.getVacuumName()} became active even though the map-load acknowledgement failed: ${this.getErrorMessage(error)}`
        );
        return;
      }

      throw error;
    }
  }

  private getCurrentMatterMapId(): number | null {
    const getCurrentMapIdForDevice = this.api.getCurrentMapIdForDevice;
    if (typeof getCurrentMapIdForDevice !== "function") {
      return null;
    }

    const currentMapId = getCurrentMapIdForDevice.call(
      this.api,
      this.getDuid()
    );

    return this.getMatterMapId(currentMapId);
  }

  private isServiceAreaEnabled(): boolean {
    return this.platform.platformConfig.enableMatterServiceArea !== false;
  }

  private isPowerSourceEnabled(): boolean {
    return this.platform.platformConfig.enableMatterPowerSource !== false;
  }

  private isCleanModeEnabled(): boolean {
    return this.platform.platformConfig.enableMatterCleanMode !== false;
  }

  private isExtendedOperationalStateEnabled(): boolean {
    return (
      this.platform.platformConfig.enableMatterExtendedOperationalStates ===
      true
    );
  }

  private isChargingDockedStateEnabled(): boolean {
    return (
      this.platform.platformConfig.enableMatterChargingDockedStates === true
    );
  }

  /**
   * Battery percentage at which a docked robot switches from Charging to
   * Docked on the Matter tile. Defaults to 100 (charging until full); users
   * with worn batteries can lower it so the tile stops claiming Charging once
   * their realistic full level is reached.
   */
  private getChargedBatteryThreshold(): number {
    const raw = this.platform.platformConfig.matterChargedBatteryThreshold;
    const value = typeof raw === "string" ? Number(raw) : raw;

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 100;
    }

    return Math.min(100, Math.max(1, Math.round(value)));
  }

  private resolveChargingDockedDisplayState(fallbackState: number): number {
    const battery = this.getNumberStatus("battery");

    if (battery === null) {
      return fallbackState;
    }

    return battery < this.getChargedBatteryThreshold()
      ? RVC_OPERATIONAL_STATE.CHARGING
      : RVC_OPERATIONAL_STATE.DOCKED;
  }

  private getOperationalStateList(): readonly number[] {
    const baseList = this.isExtendedOperationalStateEnabled()
      ? RVC_OPERATIONAL_STATE_LIST
      : RVC_BASIC_OPERATIONAL_STATE_LIST;

    // Matter requires operationalState to be a member of operationalStateList,
    // so only advertise CHARGING/DOCKED when we may actually publish them.
    return this.isChargingDockedStateEnabled()
      ? [...baseList, ...RVC_CHARGING_DOCKED_STATE_LIST]
      : baseList;
  }

  private getBatteryChargeLevel(battery: number | null): number {
    if (battery !== null && battery <= 10) {
      return BATTERY_CHARGE_LEVEL.CRITICAL;
    }

    if (battery !== null && battery < 20) {
      return BATTERY_CHARGE_LEVEL.WARNING;
    }

    return BATTERY_CHARGE_LEVEL.OK;
  }

  private getBatteryChargeState(
    battery: number | null,
    chargeStatus: number | null,
    state: number | null
  ): number {
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

  private getBatteryTimeToFullCharge(
    battery: number | null,
    chargeState: number
  ): number | null {
    if (battery === null) {
      return null;
    }

    if (chargeState === BATTERY_CHARGE_STATE.IS_AT_FULL_CHARGE) {
      return 0;
    }

    if (chargeState !== BATTERY_CHARGE_STATE.IS_CHARGING) {
      return null;
    }

    return (
      Math.ceil(100 - battery) * BATTERY_ESTIMATED_CHARGE_SECONDS_PER_PERCENT
    );
  }

  private getOperationalState(
    state = this.getNumberStatus("state"),
    chargeStatus = this.getNumberStatus("charge_status")
  ): number {
    const operationalState = this.getRoborockOperationalState(
      state,
      chargeStatus
    );

    return this.toControllerOperationalState(operationalState);
  }

  private getRoborockOperationalState(
    state: number | null,
    chargeStatus: number | null
  ): number {
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

  private toControllerOperationalState(operationalState: number): number {
    if (
      this.isExtendedOperationalStateEnabled() &&
      operationalState === RVC_OPERATIONAL_STATE.SEEKING_CHARGER
    ) {
      return operationalState;
    }

    if (
      this.isChargingDockedStateEnabled() &&
      (operationalState === RVC_OPERATIONAL_STATE.CHARGING ||
        operationalState === RVC_OPERATIONAL_STATE.DOCKED)
    ) {
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

  private isInCleaningRunMode(operationalState: number): boolean {
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

  private rememberLiveStatus(property: string, value: number | null): void {
    if (value !== null) {
      this.liveStatus.set(property, value);
      this.liveStatusUpdatedAt = Date.now();
    }
  }

  private rememberHomeDataStatus(data: unknown): void {
    const message = this.asRecord(data);
    const value = message?.val;
    if (typeof value !== "string") {
      return;
    }

    let homeData: unknown;
    try {
      homeData = JSON.parse(value);
    } catch {
      return;
    }

    const home = this.asRecord(homeData);
    const devices = Array.isArray(home?.devices) ? home.devices : [];
    const device = devices
      .map((entry) => this.asRecord(entry))
      .find((entry) => entry?.duid === this.getDuid());
    const deviceStatus = this.asRecord(device?.deviceStatus);
    if (!deviceStatus) {
      return;
    }

    this.rememberLiveStatus(
      "state",
      this.getNumberFromValue(deviceStatus.state)
    );
    this.rememberLiveStatus(
      "battery",
      this.getNumberFromValue(deviceStatus.battery)
    );
    this.rememberLiveStatus(
      "charge_status",
      this.getNumberFromValue(deviceStatus.charge_status)
    );
  }

  private getNumberStatus(property: string): number | null {
    // Prefer the freshest value from a live message, falling back to the
    // HomeData snapshot for properties live messages do not carry.
    // A stale live cache must not shadow the periodically refreshed cloud
    // snapshot forever (dead poller, connectivity loss): live values older
    // than the staleness window fall back to HomeData, which self-heals.
    const liveValue = this.liveStatus.get(property);
    if (
      liveValue !== undefined &&
      Date.now() - this.liveStatusUpdatedAt < LIVE_STATUS_STALENESS_MS
    ) {
      return liveValue;
    }

    const value = this.api.getVacuumDeviceStatus(this.getDuid(), property);

    return this.getNumberFromValue(value);
  }

  private getNumberFromValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private extractStatusUpdate(data: unknown): Record<string, unknown> | null {
    const rootMessage = this.asRecord(data);
    const dps = this.asRecord(rootMessage?.dps);

    if (dps) {
      const status: Record<string, unknown> = {};

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

    const hasStatus =
      Object.prototype.hasOwnProperty.call(message, "state") ||
      Object.prototype.hasOwnProperty.call(message, "battery") ||
      Object.prototype.hasOwnProperty.call(message, "charge_status") ||
      Object.prototype.hasOwnProperty.call(message, "clean_area") ||
      Object.prototype.hasOwnProperty.call(message, "clean_time");

    return hasStatus ? message : null;
  }

  private getLiveMessageForThisAccessory(data: unknown): unknown | null {
    return getLiveMessageForThisAccessory(data, {
      getDuid: () => this.getDuid(),
      getVacuumName: () => this.getVacuumName(),
      shouldAcceptUnscopedLiveMessage: () =>
        this.platform.shouldAcceptUnscopedLiveMessage(),
      logDebug: (message) => this.platform.log.debug(message),
    });
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  }

  private setOptimisticState(
    partialClusters: MatterClusterState,
    action: string
  ): number {
    this.optimisticClusters = this.mergeClusterState(
      this.getActiveOptimisticState() || {},
      partialClusters
    );
    this.optimisticExpiresAt = Date.now() + OPTIMISTIC_STATE_TTL_MS;
    this.optimisticGeneration += 1;
    this.optimisticAction = action;
    this.contradictingLiveStateCount = 0;

    return this.optimisticGeneration;
  }

  private reconcileOptimisticStateWithLive(
    operationalState: number,
    roborockState: number | null,
    chargeStatus: number | null
  ): void {
    const optimistic = this.getActiveOptimisticState();
    const expected = optimistic?.rvcOperationalState?.operationalState;

    if (typeof expected !== "number") {
      this.contradictingLiveStateCount = 0;
      return;
    }

    if (
      this.doesLiveStateConfirmOptimisticState(
        expected,
        operationalState,
        roborockState,
        chargeStatus
      )
    ) {
      this.clearOptimisticState();
      return;
    }

    // While a start/resume/area-clean is still spinning up, cloud-only models
    // (e.g. S8 / roborock.vacuum.a51) keep reporting docked/charging for tens of
    // seconds before they report Cleaning. During the recent-command window,
    // treat those lagging reports as transitional rather than contradictions, so
    // the optimistic Cleaning state is not starved and Apple Home does not snap
    // the tile back to Docked right after Start (issue #4).
    if (
      expected === RVC_OPERATIONAL_STATE.RUNNING &&
      this.isRoborockDockedOrCharging(roborockState, chargeStatus) &&
      this.hasRecentlyCommandedCleaning()
    ) {
      this.contradictingLiveStateCount = 0;
      return;
    }

    // The command was acknowledged but the robot reports a different state.
    // Tolerate a couple of transitional reports, then trust the live state so
    // an optimistic value cannot stay stuck until the TTL expires (e.g. a start
    // the robot ignored because the bin is full or it is off the dock).
    this.contradictingLiveStateCount += 1;
    if (this.contradictingLiveStateCount >= OPTIMISTIC_CONTRADICTION_LIMIT) {
      this.platform.log.debug(
        `Clearing optimistic Matter state for ${this.getVacuumName()} after ${this.contradictingLiveStateCount} contradicting Roborock updates (expected ${expected}, got ${operationalState}).`
      );
      this.clearOptimisticState();
    }
  }

  private doesLiveStateConfirmOptimisticState(
    expected: number,
    actual: number,
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    if (expected === actual) {
      return true;
    }

    if (
      this.optimisticAction === "return to dock" &&
      expected === RVC_OPERATIONAL_STATE.RUNNING &&
      !this.isInCleaningRunMode(actual) &&
      this.isRoborockDockedOrCharging(roborockState, chargeStatus)
    ) {
      return true;
    }

    if (
      expected === RVC_OPERATIONAL_STATE.RUNNING &&
      this.isInCleaningRunMode(actual)
    ) {
      return true;
    }

    if (
      expected === RVC_OPERATIONAL_STATE.STOPPED &&
      !this.isInCleaningRunMode(actual)
    ) {
      return true;
    }

    return (
      expected === RVC_OPERATIONAL_STATE.SEEKING_CHARGER &&
      (actual === RVC_OPERATIONAL_STATE.CHARGING ||
        actual === RVC_OPERATIONAL_STATE.DOCKED)
    );
  }

  private isRoborockDockedOrCharging(
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    return roborockState === 8 || roborockState === 100 || !!chargeStatus;
  }

  private isDockedOrChargingNow(): boolean {
    return this.isRoborockDockedOrCharging(
      this.getNumberStatus("state"),
      this.getNumberStatus("charge_status")
    );
  }

  private async publishCurrentMatterState(
    reason: string,
    options: { clearOptimistic?: boolean } = {}
  ): Promise<void> {
    if (options.clearOptimistic === true) {
      this.clearOptimisticState();
    }
    // Forced: identify commands and the heartbeat must always reach the
    // Matter layer — the heartbeat's forced full write is also the diff
    // mechanism's self-healing safety net.
    const updated = await this.publishRoborockSnapshot(
      this.buildClusters(),
      reason,
      { force: true }
    );
    if (updated) {
      this.ensureMatterStateHeartbeat();
    }
  }

  private ensureMatterStateHeartbeat(): void {
    if (!this.registered || this.matterStateHeartbeatTimer) {
      return;
    }

    const heartbeatTimer = scheduleTimer(() => {
      this.matterStateHeartbeatTimer = null;

      void this.publishCurrentMatterState("Matter state heartbeat")
        .catch((error) => {
          this.platform.log.debug(
            `Unable to publish Matter state heartbeat for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
          );
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

  private applyOptimisticState(
    clusters: MatterClusterState
  ): MatterClusterState {
    const optimistic = this.getActiveOptimisticState();
    return optimistic ? this.mergeClusterState(clusters, optimistic) : clusters;
  }

  private getActiveOptimisticState(): MatterClusterState | null {
    if (!this.optimisticClusters) {
      return null;
    }

    if (Date.now() > this.optimisticExpiresAt) {
      this.clearOptimisticState();
      return null;
    }

    return this.optimisticClusters;
  }

  private clearOptimisticState(): void {
    this.optimisticClusters = null;
    this.optimisticExpiresAt = 0;
    this.optimisticAction = null;
    this.optimisticGeneration += 1;
    this.contradictingLiveStateCount = 0;
  }

  private dispatchRoborockMatterCommand(
    action: string,
    command: () => Promise<void>,
    options: MatterCommandDispatchOptions = {}
  ): void {
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
          this.platform.log.warn(
            `Matter ${action} command for ${this.getVacuumName()} arrived before the Roborock connection finished starting up. Try again in a few seconds. ${this.getErrorMessage(error)}`
          );
          await this.recoverMatterStateAfterFailedCommand(action);
          return;
        }

        if (this.isMatterCommandTimeoutError(error)) {
          this.platform.log.warn(
            `Matter ${action} command for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`
          );
          this.schedulePostCommandStatusRefresh(action, {
            acknowledgementTimedOut: true,
          });
          if (options.retryReturnToDockIfStillActive) {
            this.scheduleReturnToDockRetry(command);
          }
          return;
        }

        this.platform.log.error(
          `Error sending Matter ${action} command to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
        await this.recoverMatterStateAfterFailedCommand(action);
      });
  }

  private scheduleReturnToDockRetry(command: () => Promise<void>): void {
    if (this.returnToDockRetryPending) {
      return;
    }

    this.returnToDockRetryPending = true;
    const retryTimer = scheduleTimer(() => {
      this.returnToDockRetryPending = false;

      void this.refreshMatterStatusBeforeRetry()
        .then(() => {
          if (!this.shouldRetryReturnToDock()) {
            this.platform.log.debug(
              `Skipping Matter return to dock retry for ${this.getVacuumName()} because Roborock no longer reports active cleaning.`
            );
            return;
          }

          const startedAt = Date.now();
          this.platform.log.warn(
            `Retrying Matter return to dock command for ${this.getVacuumName()} because Roborock still reports active cleaning after the first command timed out.`
          );

          return command()
            .then(() => {
              this.logMatterCommandDuration("return to dock retry", startedAt);
              this.schedulePostCommandStatusRefresh("return to dock retry");
            })
            .catch(async (error) => {
              if (this.isMatterCommandTimeoutError(error)) {
                this.platform.log.warn(
                  `Matter return to dock retry for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`
                );
                this.schedulePostCommandStatusRefresh("return to dock retry", {
                  acknowledgementTimedOut: true,
                });
                return;
              }

              this.platform.log.error(
                `Error sending Matter return to dock retry to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
              );
              await this.recoverMatterStateAfterFailedCommand(
                "return to dock retry"
              );
            });
        })
        .catch((error) => {
          this.platform.log.debug(
            `Unable to evaluate Matter return to dock retry for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
          );
        });
    }, MATTER_RETURN_TO_DOCK_RETRY_DELAY_MS);
    unrefTimer(retryTimer);
  }

  private async refreshMatterStatusBeforeRetry(): Promise<void> {
    const refreshStatus = this.api.getStatus;
    if (typeof refreshStatus !== "function") {
      return;
    }

    await refreshStatus.call(
      this.api,
      this.getDuid(),
      this.getMatterStatusRefreshOptions()
    );
    await this.updateMatterStateFromRoborock();
  }

  private shouldRetryReturnToDock(): boolean {
    const state = this.getNumberStatus("state");
    const chargeStatus = this.getNumberStatus("charge_status");

    if (this.isRoborockDockedOrCharging(state, chargeStatus)) {
      return false;
    }

    return this.isRoborockActivelyCleaningAwayFromDock(state);
  }

  private isRoborockActivelyCleaningAwayFromDock(
    state: number | null
  ): boolean {
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

  private async recoverMatterStateAfterFailedCommand(
    action: string
  ): Promise<void> {
    try {
      await this.publishCurrentMatterState(
        `${action} command failure recovery`,
        { clearOptimistic: true }
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to recover Matter state after failed ${action} command for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
      );
    }
  }

  private isMatterCommandTimeoutError(error: unknown): boolean {
    return /timed out after \d+ seconds/.test(this.getErrorMessage(error));
  }

  private isDeviceNotReadyError(error: unknown): boolean {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ROBOROCK_DEVICE_NOT_READY"
    ) {
      return true;
    }

    // Also match the upstream phrasing used by getServerTimers and
    // updateServerTimer ("Vacuum <duid> is not initialized.").
    return /is not initialized/i.test(this.getErrorMessage(error));
  }

  private isMatterInitializingError(error: unknown): boolean {
    return /\bis still initializing\b/i.test(this.getErrorMessage(error));
  }

  private scheduleMatterInitializationRetry(
    reason: string,
    error: unknown
  ): void {
    if (this.matterInitializationRetryPending) {
      return;
    }

    const delayMs =
      MATTER_INITIALIZATION_RETRY_DELAYS_MS[
        this.matterInitializationRetryAttempt
      ];
    if (delayMs === undefined) {
      this.platform.log.debug(
        `Matter state update after ${reason} for ${this.getVacuumName()} is still waiting on Homebridge endpoint initialization; suppressing additional startup retries. Last error: ${this.getErrorMessage(error)}`
      );
      return;
    }

    this.matterInitializationRetryAttempt += 1;
    this.matterInitializationRetryPending = true;
    this.platform.log.debug(
      `Matter state update after ${reason} for ${this.getVacuumName()} was delayed because Homebridge says the endpoint is still initializing; retrying in ${delayMs} ms.`
    );

    const retryTimer = scheduleTimer(() => {
      this.matterInitializationRetryPending = false;
      this.scheduleMatterStateRefresh(
        `endpoint initialization retry (${reason})`
      );
    }, delayMs);
    unrefTimer(retryTimer);
  }

  private logMatterCommandDuration(action: string, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    const transport = this.getTransportDescription();
    const message =
      `Matter ${action} command for ${this.getVacuumName()} was acknowledged ` +
      `by Roborock in ${durationMs} ms${transport ? ` via ${transport}` : ""}.`;

    if (durationMs >= SLOW_MATTER_COMMAND_MS) {
      this.platform.log.warn(`Slow ${message}`);
      return;
    }

    this.platform.log.info(message);
  }

  private schedulePostCommandStatusRefresh(
    action: string,
    options: { acknowledgementTimedOut?: boolean } = {}
  ): void {
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
            this.platform.log.debug(
              `Unable to refresh Matter status after ${action} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
            );
          });
      }, delayMs);
      unrefTimer(refreshTimer);
    }
  }

  private getMatterStatusRefreshOptions(): RoborockStatusRefreshOptions {
    const options: RoborockStatusRefreshOptions = { force: true };
    if (this.platform.platformConfig.preferCloudForMatterCommands) {
      options.preferCloud = true;
    }

    return options;
  }

  private getTransportDescription(): string {
    const diagnostics =
      typeof this.api.getTransportDiagnostics === "function"
        ? this.api.getTransportDiagnostics()
        : null;
    const transport =
      diagnostics && typeof diagnostics === "object"
        ? diagnostics[this.getDuid()]
        : null;

    if (!transport || typeof transport !== "object") {
      return "";
    }

    const lastTransport =
      "lastTransport" in transport ? String(transport.lastTransport) : "";
    const lastReason =
      "lastTransportReason" in transport
        ? String(transport.lastTransportReason)
        : "";

    if (lastTransport && lastReason) {
      return `${lastTransport} (${lastReason})`;
    }

    return lastTransport;
  }

  private getErrorMessage(error: unknown): string {
    if (error === undefined || error === null) {
      return "unknown error";
    }

    return error instanceof Error ? error.message : String(error);
  }

  private mergeClusterState(
    base: MatterClusterState,
    override: MatterClusterState
  ): MatterClusterState {
    const merged: MatterClusterState = { ...base };

    for (const [cluster, attributes] of Object.entries(override)) {
      merged[cluster] = {
        ...(merged[cluster] || {}),
        ...attributes,
      };
    }

    return merged;
  }

  private getVacuumName(): string {
    return (
      this.api.getVacuumDeviceInfo(this.getDuid(), "name") ||
      this.accessory.displayName ||
      "Roborock vacuum"
    );
  }

  private getDuid(): string {
    return String(this.accessory.context.duid);
  }
}
