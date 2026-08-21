import { setTimeout as nodeSetTimeout } from "node:timers";

import RoborockPlatform from "./platform";
import { getLiveMessageForThisAccessory } from "./live_message";
import { HomeKitActionKey, HomeKitStateSensorKey } from "./types";
import { clearTimer, scheduleTimer, unrefTimer } from "./timers";

const { getModelMarketingName } =
  require("../roborockLib/lib/deviceFeatures") as {
    getModelMarketingName: (model: unknown) => string | null;
  };

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

type RoborockCleanModePrepOptions = RoborockCommandOptions & {
  // The whole prep sequence is raced against this one window before the start
  // command is sent (see withCleanModePrepTimeout). It travels with the
  // options so the protocol layer can size each command's timeout from what is
  // LEFT of the window, instead of starting a command the caller will not wait
  // for. Without it, three sequential two-second commands were being issued
  // inside a 2.5 second window, so the command carrying the user's clean mode
  // could still be in flight when the start command overtook it (#8).
  prepWindowMs: number;
};

// What the prep sequence resolved with. It resolves rather than rejecting on a
// partial apply — the start command goes out either way — so this is the only
// place the caller can learn that the user's clean TYPE never landed.
// `cleanTypeConfirmed` is false only when a type-carrying command went
// unconfirmed; an unconfirmed suction level is a level inside the type and
// leaves it true.
type RoborockCleanModePrepResult = {
  unconfirmedSettings?: string[];
  cleanTypeConfirmed?: boolean;
};

type RoborockStatusRefreshOptions = {
  force?: boolean;
  preferCloud?: boolean;
};

type MatterCommandDispatchOptions = {
  retryReturnToDockIfStillActive?: boolean;
  /** Which control surface asked for this — see MATTER_SURFACE. */
  surface?: string;
};

// Commands reach this class from two places now: the Matter clusters, and the
// optional HAP action switches. The surface is threaded through the command
// path rather than inferred, because the only way a user can tell a dropped
// automation from a dropped tile press is the log line that names which one
// sent the command.
export const MATTER_SURFACE = "Matter";
export const HOME_SWITCH_SURFACE = "Home switch";

/** "Matter" reads bare; anything else takes an article. */
function surfacePhrase(surface: string): string {
  return surface === MATTER_SURFACE ? surface : `the ${surface}`;
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
    options?: RoborockCleanModePrepOptions
  ): Promise<RoborockCleanModePrepResult | void>;
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

// The status fields a live frame can carry that the Matter publish actually
// reads. Both the gate in extractStatusUpdate and the "nothing meaningful
// arrived" check in updateMatterStateFromMessage derive from this one list, so
// the two cannot disagree about what counts as an update.
//
// They did disagree: the caller was taught that a frame carrying only
// `fan_power` or only `matter_clean_type` is meaningful — a suction or
// mop-mode change made in the Roborock app, or picked by SmartPlan, pushes
// exactly that — while the gate one level below still dropped such a frame
// before the caller ever saw it. A hand-written field list in two places is
// the same defect as a hand-written file list: adding a field to one of them
// silently leaves the other behind.
// The tank fields are in this list on purpose. A frame carrying only one of
// them is meaningful: the gate returns early when nothing meaningful arrived,
// so leaving them out would drop a tank-only frame before it was ever
// remembered — and Roborock sends sparse frames as a matter of course. That
// is the same bug 3.12.1 fixed one layer up, and the gate test caught the
// second attempt at it.
const MEANINGFUL_LIVE_STATUS_FIELDS = [
  "state",
  "charge_status",
  "battery",
  "clean_area",
  "clean_time",
  "fan_power",
  "matter_clean_type",
  "dock_error_status",
  "water_shortage_status",
  "error_code",
  "dry_status",
] as const;

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

// Fan-power clean modes (enableFanPowerCleanModes, default ON since 3.12.0;
// was off since
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

/**
 * The dock's own code for "the clean-water tank is empty".
 *
 * Field-measured rather than inferred. Wazza151 emptied and refilled the tank
 * on an S8 Pro Ultra (issue #5) and `dock_error_status` tracked it exactly;
 * vp-debug12's Q Revo carried the same 38 while confirming in issue #9 that
 * the tank was empty. Both are named here because the two robots disagree on
 * everything else about this condition — see isWaterTankEmpty().
 *
 * Only 38 is claimed. `dock_error_status` carries the dock's whole family of
 * housekeeping faults (full waste-water tank, missing dust bag, blocked duct),
 * and "non-zero" would report a full waste-water tank as an empty clean one.
 */
const DOCK_ERROR_CLEAN_WATER_TANK_EMPTY = 38;

/**
 * Matter's own RVC OperationalError codes.
 *
 * 68 is `WaterTankEmpty`, and it is the attribute Apple Home draws as a tap
 * icon on the play button with a localised "refill the water tank" — the one
 * value in this list measured rendering on real hardware (a70, iOS 26.0).
 * 0 is `NoError` and has to be published too: an error attribute that is only
 * ever written when something is wrong never clears.
 *
 * WHY THIS LIST STOPS AT 71.
 *
 * The enum continues: the specification adds LowBattery (72),
 * CannotReachTargetArea (73), DirtyWaterTankFull (74), DirtyWaterTankMissing
 * (75), WheelsJammed (76), BrushJammed (77) and NavigationSensorObscured (78).
 * Several of those name a Roborock fault exactly, and mapping to them would
 * read better than the generic codes used below.
 *
 * They are all Matter 1.5. Everything from 0 to 71 has been in the cluster
 * since 1.2. Nothing here establishes which revision Apple implements, and
 * this file already carries one measurement of what Apple does with a value
 * it does not recognise: a manufacturer-range id in `operationalStateList`
 * leaves the tile in "Connecting" forever. A fault that renders as nothing
 * would only cost the message; a fault that wedges the accessory costs the
 * robot. Until somebody looks at a tile with 76 on it, the 1.2 set is what
 * gets published, and the accurate 1.5 name goes in the log line instead.
 */
const RVC_OPERATIONAL_ERROR = {
  NO_ERROR: 0,
  UNABLE_TO_START_OR_RESUME: 1,
  UNABLE_TO_COMPLETE_OPERATION: 2,
  FAILED_TO_FIND_CHARGING_DOCK: 64,
  STUCK: 65,
  DUST_BIN_MISSING: 66,
  DUST_BIN_FULL: 67,
  WATER_TANK_EMPTY: 68,
  WATER_TANK_MISSING: 69,
  WATER_TANK_LID_OPEN: 70,
  MOP_CLEANING_PAD_MISSING: 71,
} as const;

/**
 * The dock's own jobs, named for `RvcOperationalState.PhaseList`.
 *
 * Drying is why this exists. Matter has an operational state for emptying the
 * dust bin (0x43), washing the mop (0x44) and updating maps (0x46), and the
 * plugin publishes all 3 — but the dock then spends 2 to 4 hours blowing air
 * through a wet mop, and the specification has no state for that at all. A
 * phase is the only place it can be said.
 *
 * THE LIST IS CONSTANT AND MUST STAY CONSTANT. `PhaseList` is not a Fixed
 * attribute, so rewriting it is legal — and 1.4.58 removed a version of this
 * plugin that changed phases as a refresh trick and flapped them against every
 * Apple Home hub in the house. Only `CurrentPhase` moves here. A test fails if
 * the list is ever built from anything but this constant.
 *
 * The other 3 are included even though each has its own operational state,
 * because those states are optional in the device type and nothing establishes
 * that Apple draws them. A phase costs nothing extra and gives the same fact a
 * second route to the tile.
 */
const RVC_PHASE_LIST = [
  "Emptying dust bin",
  "Washing mop",
  "Drying mop",
  "Updating maps",
] as const;

const RVC_PHASE = {
  EMPTYING_DUST_BIN: 0,
  WASHING_MOP: 1,
  DRYING_MOP: 2,
  UPDATING_MAPS: 3,
} as const;

/** Reverse lookup for the published id, so the log line says what was sent. */
const RVC_OPERATIONAL_ERROR_NAMES: Readonly<Record<number, string>> = {
  [RVC_OPERATIONAL_ERROR.UNABLE_TO_START_OR_RESUME]: "Unable to start",
  [RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION]:
    "Unable to complete operation",
  [RVC_OPERATIONAL_ERROR.FAILED_TO_FIND_CHARGING_DOCK]:
    "Failed to find charging dock",
  [RVC_OPERATIONAL_ERROR.STUCK]: "Stuck",
  [RVC_OPERATIONAL_ERROR.DUST_BIN_MISSING]: "Dust bin missing",
  [RVC_OPERATIONAL_ERROR.DUST_BIN_FULL]: "Dust bin full",
  [RVC_OPERATIONAL_ERROR.WATER_TANK_EMPTY]: "Clean water tank empty",
  [RVC_OPERATIONAL_ERROR.WATER_TANK_MISSING]: "Water tank missing",
  [RVC_OPERATIONAL_ERROR.WATER_TANK_LID_OPEN]: "Water tank lid open",
  [RVC_OPERATIONAL_ERROR.MOP_CLEANING_PAD_MISSING]: "Mop pad missing",
};

/**
 * Roborock's `error_code` translated into a Matter fault.
 *
 * The source table is `errorCodes` in roborockLib/lib/deviceFeatures.js, which
 * this plugin has carried and polled since the fork and has never once shown
 * to a user. A robot wedged under a sofa publishes operational state 3 (Error)
 * and no reason, so Apple Home draws a robot that has stopped and cannot say
 * why. That is what this fixes: the state was already there, only the reason
 * was missing.
 *
 * `roborock` is the plugin's own text and is logged, not published — the
 * `ErrorStateLabel`/`ErrorStateDetails` fields that could carry it are
 * unmeasured on Apple Home and this attribute has a history of being brittle.
 * `spec` names the Matter 1.5 code that would be more accurate than the id
 * actually sent, and is logged for the same reason: so the next person can see
 * what the mapping gave up and why.
 */
const ROBOROCK_ERROR_TO_MATTER: ReadonlyMap<
  number,
  { id: number; roborock: string; spec?: string }
> = new Map([
  [
    1,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Laser sensor fault",
      spec: "NavigationSensorObscured (78)",
    },
  ],
  [2, { id: RVC_OPERATIONAL_ERROR.STUCK, roborock: "Collision sensor fault" }],
  [
    3,
    {
      id: RVC_OPERATIONAL_ERROR.STUCK,
      roborock: "Wheel floating",
      spec: "WheelsJammed (76)",
    },
  ],
  [
    4,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Cliff sensor fault",
      spec: "NavigationSensorObscured (78)",
    },
  ],
  [
    5,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Main brush blocked",
      spec: "BrushJammed (77)",
    },
  ],
  [
    6,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Side brush blocked",
      spec: "BrushJammed (77)",
    },
  ],
  [
    7,
    {
      id: RVC_OPERATIONAL_ERROR.STUCK,
      roborock: "Wheel blocked",
      spec: "WheelsJammed (76)",
    },
  ],
  [8, { id: RVC_OPERATIONAL_ERROR.STUCK, roborock: "Device stuck" }],
  [
    9,
    {
      id: RVC_OPERATIONAL_ERROR.DUST_BIN_MISSING,
      roborock: "Dust bin missing",
    },
  ],
  [
    10,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Filter blocked",
    },
  ],
  [
    11,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Magnetic field detected",
    },
  ],
  [
    12,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_START_OR_RESUME,
      roborock: "Low battery",
      spec: "LowBattery (72)",
    },
  ],
  [
    13,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_START_OR_RESUME,
      roborock: "Charging problem",
    },
  ],
  [
    14,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Battery failure",
    },
  ],
  [
    15,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Wall sensor fault",
      spec: "NavigationSensorObscured (78)",
    },
  ],
  [16, { id: RVC_OPERATIONAL_ERROR.STUCK, roborock: "Uneven surface" }],
  [
    17,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Side brush failure",
      spec: "BrushJammed (77)",
    },
  ],
  [
    18,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Suction fan failure",
    },
  ],
  [
    19,
    {
      id: RVC_OPERATIONAL_ERROR.FAILED_TO_FIND_CHARGING_DOCK,
      roborock: "Unpowered charging station",
    },
  ],
  [
    20,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Unknown error",
    },
  ],
  [
    21,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Laser pressure sensor problem",
    },
  ],
  [
    22,
    {
      id: RVC_OPERATIONAL_ERROR.FAILED_TO_FIND_CHARGING_DOCK,
      roborock: "Charge sensor problem",
    },
  ],
  [
    23,
    {
      id: RVC_OPERATIONAL_ERROR.FAILED_TO_FIND_CHARGING_DOCK,
      roborock: "Dock problem",
    },
  ],
  [
    24,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_START_OR_RESUME,
      roborock: "No-go zone or invisible wall detected",
      spec: "CannotReachTargetArea (73)",
    },
  ],
  [254, { id: RVC_OPERATIONAL_ERROR.DUST_BIN_FULL, roborock: "Bin full" }],
  [
    255,
    {
      id: RVC_OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION,
      roborock: "Internal error",
    },
  ],
]);

const RVC_OPERATIONAL_STATE_LIST = [
  RVC_OPERATIONAL_STATE.STOPPED,
  RVC_OPERATIONAL_STATE.RUNNING,
  RVC_OPERATIONAL_STATE.PAUSED,
  RVC_OPERATIONAL_STATE.ERROR,
  RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
  // Dock activities. These were the whole point of the "Extended Operational
  // States" toggle, but they were missing from this list, and Matter requires
  // operationalState to be a member of operationalStateList — so even a
  // correctly derived "emptying the dust bin" could not legally be published.
  RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN,
  RVC_OPERATIONAL_STATE.CLEANING_MOP,
  RVC_OPERATIONAL_STATE.UPDATING_MAPS,
] as const;

// The basic (non-extended) operational state list is the first four entries
// of the full list, without SEEKING_CHARGER.
const RVC_BASIC_OPERATIONAL_STATE_LIST = RVC_OPERATIONAL_STATE_LIST.slice(0, 4);

// Dock chores: the robot is parked in its dock doing housekeeping. None of
// them starts or ends a cleaning run — whether one is in progress was decided
// before the chore began, and is decided again when it is over.
const DOCK_ACTIVITY_STATES: ReadonlySet<number> = new Set([
  RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN,
  RVC_OPERATIONAL_STATE.CLEANING_MOP,
  RVC_OPERATIONAL_STATE.UPDATING_MAPS,
]);

// The states that must not DECIDE a run mode, only inherit the one already
// published: the dock chores plus every kind of transit (returning to dock,
// docking, going to wash the mop, all of which derive to SEEKING_CHARGER).
//
// Driving somewhere is never the start of a cleaning, and it is not the end of
// one either — a run ends when the robot docks. Inheriting delivers both: a
// robot that was cleaning keeps saying Cleaning until it is home, and a robot
// that never left its dock stays Idle through the one-second transit blip the
// dock leaves behind after emptying the dust bin (issue #9, second report).
//
// This happens to hold the same members as EXTENDED_OPERATIONAL_STATES today.
// That is a coincidence of Roborock's state table, not a shared meaning — one
// says what a toggle may display, the other says what may claim a cleaning —
// so do not merge them.
const RUN_MODE_INHERITED_STATES: ReadonlySet<number> = new Set([
  ...DOCK_ACTIVITY_STATES,
  RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
]);

// The states that the "Extended Operational States" toggle unlocks. Publishing
// any of these requires them to be advertised, which is why this set and
// RVC_OPERATIONAL_STATE_LIST must stay in agreement. Derived from the dock
// chores rather than re-listing them: a second hand-written copy of a list is
// the most repeated defect in this codebase.
const EXTENDED_OPERATIONAL_STATES: ReadonlySet<number> = new Set([
  RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
  ...DOCK_ACTIVITY_STATES,
]);

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
  // The last "Matter publish for …" line actually written to the log. The
  // emit decision compares rendered lines rather than a hand-picked field
  // list, so every value the line names — and every value added to it later —
  // triggers it by construction.
  private lastLoggedMatterPublishLine: string | null = null;
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
  // The run mode last decided by a state that was not a dock chore. Dock
  // chores inherit it instead of deciding one of their own — see
  // resolveRunMode(). Idle is the honest starting point: a plugin that boots
  // while the dock is emptying knows of no run in progress.
  private lastRunMode = RUN_MODE_IDLE;
  // The run mode as it went out to Matter, optimistic overlay included. The
  // read-only "Cleaning" state sensor answers from this so it and the Apple
  // Home tile always say the same thing. Null until the first publish.
  private lastPublishedRunMode: number | null = null;
  // Notified after every publish, by whoever wants to mirror this robot's state
  // somewhere else. Null means nobody asked, which is the common case.
  private stateListener: (() => void) | null = null;
  // The suction-level clean mode last derived from a fan power the plugin
  // could actually read. Used only as the answer to "the fan power is
  // unreadable right now" while suction levels are announced; cleared by an
  // explicit Apple Home selection so the user's choice always wins.
  private lastResolvedFanPowerCleanMode: number | null = null;
  // The base clean TYPE this plugin applied for the run in progress, held
  // until the robot's own report agrees with it once. A robot that has just
  // acknowledged "water off" keeps reporting the old water level for a while,
  // and the live derivation below reads that lagging value as vacuum+mop —
  // contradicting a command this plugin sent and had acknowledged seconds
  // earlier. Released when the robot's report catches up, when the run it was
  // applied for ends, and by an explicit Apple Home selection.
  private appliedCleanTypePin: {
    /** The base clean type that was sent and acknowledged. */
    cleanType: number;
    /** Whether the run it was applied for has actually been seen running. */
    runObserved: boolean;
    /** Whether the robot's disagreement has already been reported once. */
    reported: boolean;
  } | null = null;
  private lastVacuumFanPower: number | null = null;
  private lastWaterBoxMode: number | null = null;
  private readonly reportedUnmappedErrorCodes = new Set<number>();
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

  private getMatterCleanModePrepCommandOptions(): RoborockCleanModePrepOptions {
    return {
      ...this.getMatterCommandOptions(),
      requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
      // Derived from the same constant the prep is raced against, so the two
      // cannot drift apart: whatever window this class enforces is the window
      // the protocol layer budgets its commands inside.
      prepWindowMs: MATTER_CLEAN_MODE_PREP_TIMEOUT_MS,
    };
  }

  /** The robot's name exactly as the log lines and Apple Home spell it. */
  getDisplayName(): string {
    return this.getVacuumName();
  }

  /**
   * Whether this robot can actually perform the action behind a HAP switch.
   *
   * Only `locate` is conditional: `find_me` is optional on the Roborock API
   * and absent on some models, and identifyVacuum already degrades to a debug
   * line rather than an error when it is missing. A switch that silently does
   * nothing is worse than no switch, so an unsupported action is never
   * published in the first place.
   */
  supportsHomeKitAction(action: HomeKitActionKey): boolean {
    if (action === "locate") {
      return typeof this.api.find_me === "function";
    }

    return true;
  }

  /**
   * The value a read-only HAP state sensor should show, or null for "not yet".
   *
   * Both arms read the ROBOT'S OWN state, never the controller-facing one that
   * toControllerOperationalState() produces. That is not a stylistic choice: it
   * is the fault form this file has now been bitten by seven times. CHARGING
   * and DOCKED are rewritten to STOPPED unless the user enabled the
   * charging/docked toggle, and the dock chores are rewritten to RUNNING unless
   * they enabled the extended-states one — so a docked sensor built on the
   * published operational state would have worked only for the users who had
   * ticked an unrelated box, and reported "not docked" for everybody else.
   *
   * `cleaning` mirrors the run mode that was last PUBLISHED rather than
   * recomputing one, for three reasons. It is the value Apple Home was actually
   * told, so the sensor and the tile cannot disagree — including during the
   * optimistic window after a command, where the tile moves before the robot
   * confirms and a sensor computed from raw status would lag it by a poll. It
   * carries 3.6.2's rule that a dock chore inherits the run mode it interrupted,
   * so emptying the dust bin does not make the sensor announce a cleaning that
   * is not happening — the exact bug issue #9 reported against the tile, which
   * would otherwise have been reintroduced one surface over. And resolveRunMode()
   * is deliberately NOT called here: it assigns lastRunMode, and a getter a HAP
   * read can reach must not advance the state machine that decides what gets
   * published.
   */
  /** Ask to be told after every publish. Null clears it. */
  setStateListener(listener: (() => void) | null): void {
    this.stateListener = listener;
  }

  getHomeKitStateSensorValue(sensor: HomeKitStateSensorKey): boolean | null {
    if (!this.hasUsableRobotState()) {
      return null;
    }

    switch (sensor) {
      case "docked":
        return this.isDockedOrChargingNow();
      case "cleaning":
        return (
          (this.lastPublishedRunMode ?? this.lastRunMode) === RUN_MODE_CLEANING
        );
      case "waterTankEmpty":
        return this.isWaterTankEmpty();
      default:
        return null;
    }
  }

  /**
   * Whether the robot says it has no water, or null if it has not said.
   *
   * Two robots have now been measured with a physically empty clean-water tank
   * and they do NOT agree on how they say so:
   *
   *   a70  (S8 Pro Ultra, issue #5)  dock_error_status 38, water_shortage_status 0
   *   a75  (Q Revo,       issue #9)  dock_error_status 38, water_shortage_status 1
   *
   * So neither field alone covers both, and the a70's zero is the reason this
   * is an OR rather than a preference order: reading `water_shortage_status`
   * first and trusting its 0 would report a full tank on the very robot the
   * condition was field-measured on. Robots that carry their water onboard and
   * have no dock tank at all are the mirror case — nothing sets
   * `dock_error_status` for them, and the shortage flag is all there is.
   *
   * Null when neither field is present. That is not the same as "not empty":
   * an absent field is the robot declining to answer, and a sensor that
   * answered "full" on its behalf would be inventing the one reading a user
   * would act on. Null leaves the sensor at rest instead, and rest is Open.
   */
  private isWaterTankEmpty(): boolean | null {
    const dockError = this.getNumberStatus("dock_error_status");
    const shortage = this.getNumberStatus("water_shortage_status");

    if (dockError === null && shortage === null) {
      return null;
    }

    return (
      dockError === DOCK_ERROR_CLEAN_WATER_TANK_EMPTY ||
      (shortage !== null && shortage !== 0)
    );
  }

  /**
   * The single fault to publish, or null when the robot has not said anything
   * either way.
   *
   * Order matters and it is not arbitrary. An empty clean-water tank wins,
   * because 68 is the one code measured rendering on a real tile and because
   * `dock_error_status` describes the dock while `error_code` describes the
   * robot — a docked robot can carry both at once and the tank is the one the
   * user can act on. Below that comes the robot's own fault. Only when both
   * are known and neither is a fault does this return NoError.
   *
   * Returning null rather than NoError for an unknown robot is the 3.12.1
   * lesson applied to a second field: publishing NoError on the robot's behalf
   * would clear a warning nobody has contradicted.
   */
  private getMatterFault(): { id: number; text: string } | null {
    const tankEmpty = this.isWaterTankEmpty();
    if (tankEmpty === true) {
      return {
        id: RVC_OPERATIONAL_ERROR.WATER_TANK_EMPTY,
        text: "Clean water tank empty",
      };
    }

    const errorCode = this.getNumberStatus("error_code");
    if (errorCode !== null && errorCode !== 0) {
      // The table is Roborock's v1 numbering. A B01/Q7 robot's `fault` field
      // is a different space entirely — 407, 2105 — passed through under the
      // same name by the adapter, so reading 254 from one of those robots as
      // "bin full" would be a coincidence, not a translation.
      const speaksV1ErrorCodes =
        this.getNumberStatus("matter_clean_type") === null;
      const mapped = speaksV1ErrorCodes
        ? ROBOROCK_ERROR_TO_MATTER.get(errorCode)
        : undefined;
      if (mapped) {
        return {
          id: mapped.id,
          text: mapped.spec
            ? `${mapped.roborock}, Roborock ${errorCode}; spec has ${mapped.spec}`
            : `${mapped.roborock}, Roborock ${errorCode}`,
        };
      }

      // An error_code with no entry in the table publishes NOTHING, and this
      // is the correction 3.13.1 exists for.
      //
      // 3.13.0 published a generic fault for it, on the reasoning that a
      // robot which has stopped saying nothing is worse than a robot saying
      // something vague. That reasoning had a hole, and 2 of the maintainer's
      // own robots found it within the hour: both sat docked at 100 %, both
      // carrying `error_code: 2105`, and both got a fault drawn on a tile
      // that had nothing wrong with it. The B01/Q7 fault channel is
      // documented in this very repository as one where informational codes
      // linger after harmless events — the adapter already zeroes 407 for
      // exactly that reason.
      //
      // So an unrecognised number is not evidence of a fault. It is evidence
      // of a number. It gets logged once so it can be reported and mapped,
      // and the attribute is left alone: no fault invented, and no existing
      // fault cleared either.
      this.reportUnmappedErrorCode(errorCode);
      return null;
    }

    if (tankEmpty === false || errorCode === 0) {
      // At least one source affirmatively says it is fine and neither says
      // otherwise. Requiring both to be known would mean a robot that never
      // reports `error_code` could never clear a tank warning after a refill,
      // which is worse than no warning at all.
      return { id: RVC_OPERATIONAL_ERROR.NO_ERROR, text: "" };
    }

    // Neither source has said anything.
    return null;
  }

  /**
   * The phase attributes, with an escape hatch.
   *
   * On by default, and not on the settings page — 3.12.0 removed that whole
   * section. This exists for the same reason the fault attribute's key does:
   * a controller that dislikes an attribute can leave a tile unusable, and
   * this plugin has measured Apple Home refusing to finish commissioning over
   * a neighbouring list attribute it did not like. `PhaseList` is a list of
   * manufacturer-defined strings by design, which is not the same situation —
   * but "not the same situation" is what was said before, twice, and both
   * times a line in config.json would have saved somebody a reinstall.
   */
  private areDockPhasesEnabled(): boolean {
    return this.platform.platformConfig.enableMatterDockPhases !== false;
  }

  /**
   * Is the dock drying the mop right now?
   *
   * One field, 2 producers. A v1 robot with a drying dock reports `dry_status`
   * itself — it is declared in this library's own feature table under
   * `isSupportedDrying()`, gated on the robot's capability bitmask. A B01/Q7
   * reports raw status 10, `mop_airdrying`, which the adapter maps to v1 state
   * 8 so the tile reads Docked; since 3.14.0 it also writes `dry_status` under
   * the same name so the fact is not lost in that mapping.
   *
   * Null means the robot has not said, which is not the same as "not drying" —
   * a robot with no drying dock never reports the field at all.
   */
  private isMopDrying(): boolean | null {
    const dryStatus = this.getNumberStatus("dry_status");
    if (dryStatus === null) {
      return null;
    }
    return dryStatus !== 0;
  }

  /**
   * The index into RVC_PHASE_LIST, or null when the dock is not doing any of
   * its own jobs.
   *
   * Order is deliberate: the states the robot reports directly win over the
   * derived one. A dock washing the mop is also, technically, about to dry it,
   * and saying "Washing mop" while it washes is the more useful of the 2.
   */
  private getCurrentPhase(): number | null {
    // The UNGATED state on purpose. `getOperationalState` applies the user's
    // extended-states choice, and someone who has turned those off has asked
    // for a plainer tile, not for the dock to stop saying what it is doing.
    // A phase naming the sub-activity inside a running state is exactly the
    // shape the base cluster describes, so the 2 attributes do not contradict
    // each other even when the gate is closed.
    const dockActivity = this.getRoborockOperationalState(
      this.getNumberStatus("state"),
      this.getNumberStatus("charge_status")
    );

    switch (dockActivity) {
      case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
        return RVC_PHASE.EMPTYING_DUST_BIN;
      case RVC_OPERATIONAL_STATE.CLEANING_MOP:
        return RVC_PHASE.WASHING_MOP;
      case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
        return RVC_PHASE.UPDATING_MAPS;
      default:
        break;
    }

    return this.isMopDrying() === true ? RVC_PHASE.DRYING_MOP : null;
  }

  /**
   * Name an unmapped error_code in the log once per code, per robot, per run.
   *
   * Once, because these codes linger: 2105 was present on every poll of 2
   * robots for the whole evening it was found, and a line per poll would bury
   * the log the way the ioBroker leftover did before 3.11.2 removed it.
   */
  private reportUnmappedErrorCode(errorCode: number): void {
    if (this.reportedUnmappedErrorCodes.has(errorCode)) {
      return;
    }
    this.reportedUnmappedErrorCodes.add(errorCode);
    this.platform.log.info(
      `${this.getVacuumName()} reports error_code ${errorCode}, which this plugin has no mapping for. ` +
        "Nothing is published to Apple Home for it, because an unrecognised code is as likely to be " +
        "informational as it is to be a fault. If the robot really is in trouble right now, please report " +
        "the number and what the Roborock app says: " +
        "https://github.com/mathiashornbek/homebridge-roborock-matter/issues"
    );
  }

  /**
   * Whether the robot has reported enough for a sensor to claim anything.
   *
   * State 0 is not a Roborock state — the enum starts at 1 and the mapping
   * switch has no arm for it, so it falls to the default branch and comes out
   * as STOPPED. That is indistinguishable from a robot that is genuinely idle
   * off its dock, which is why this is checked here rather than left to the
   * mapping: a Q7 on this account has been measured reporting state 0 for 27
   * seconds after every restart, and a sensor that believed it would report
   * "not docked" for a robot sitting in its dock, then flip — firing every
   * automation triggered on the robot leaving, on every Homebridge restart.
   *
   * A non-zero charge_status is a complete answer on its own: the robot is on
   * the dock drawing power whatever it says its state is.
   */
  private hasUsableRobotState(): boolean {
    const chargeStatus = this.getNumberStatus("charge_status");
    if (chargeStatus !== null && chargeStatus !== 0) {
      return true;
    }

    const state = this.getNumberStatus("state");
    return state !== null && state !== 0;
  }

  /**
   * Perform an action requested by one of the optional HAP switches.
   *
   * This deliberately routes into the same private methods the Matter cluster
   * handlers use, rather than calling app_charge/app_pause directly. Those
   * methods carry every lesson the command path has already learned —
   * acknowledgement waiting and timing logs (issue #12), forwarding a command
   * the cached snapshot claims is unnecessary (issue #4), the return-to-dock
   * retry when Roborock times out but is still cleaning, and the optimistic
   * cluster write that moves the Matter tile. A switch that bypassed them
   * would be a second, worse command path that re-earns all four bugs.
   */
  async runHomeKitAction(action: HomeKitActionKey): Promise<void> {
    switch (action) {
      case "clean":
        await this.startCleaning(HOME_SWITCH_SURFACE);
        return;
      case "dock":
        await this.returnToDock(HOME_SWITCH_SURFACE);
        return;
      case "pause":
        await this.pauseCleaning(HOME_SWITCH_SURFACE);
        return;
      case "locate":
        await this.identifyVacuum(HOME_SWITCH_SURFACE);
        return;
    }
  }

  markRegistered(): void {
    this.registered = true;
    // Fresh registration: nothing is published on the new node yet.
    this.lastPublishedClusterJson.clear();
    // …and nothing has been stated about it either, so the evidence line is
    // restated for the new node instead of being suppressed as unchanged.
    this.lastLoggedMatterPublishLine = null;
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
    // Reads as a name, not a code (#10). Note that neither this nor the
    // manufacturer above reaches Apple Home yet: Homebridge discards both for
    // external Matter accessories and reports "Homebridge" with the display
    // name as the model (homebridge/homebridge#3996). They are correct here so
    // that they are right the moment that lands, and they are already visible
    // in the Homebridge UI and on the HAP sensors today.
    //
    // Resolved here rather than delegated to the platform on purpose: this
    // accessory is constructed directly by two dozen test harnesses whose
    // platform is a stub, and reaching for a platform method for a pure
    // model-string lookup made every one of them a mock-shape problem.
    const reportedModel =
      this.api.getProductAttribute(duid, "model") ||
      this.api.getVacuumDeviceInfo(duid, "model");
    this.accessory.model =
      getModelMarketingName(reportedModel) ||
      reportedModel ||
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

    const updated = await this.publishRoborockSnapshot(
      this.buildClusters(),
      "Roborock state refresh"
    );
    if (updated) {
      this.ensureMatterStateHeartbeat();
    }
  }

  /**
   * Render the publish evidence line for a full cluster snapshot.
   *
   * When a user reports "Apple Home shows nothing", this is the line that
   * says whether the plugin sent anything to show.
   */
  private buildMatterPublishLogLine(clusters: MatterClusterState): string {
    const power = clusters.powerSource as Record<string, unknown> | undefined;
    const halfPercent = power?.batPercentRemaining;
    const opState = clusters.rvcOperationalState as
      | Record<string, unknown>
      | undefined;
    const runMode = clusters.rvcRunMode as Record<string, unknown> | undefined;
    const cleanMode = clusters.rvcCleanMode as
      | Record<string, unknown>
      | undefined;
    // The fault field is back, and only because something is published into
    // it again. 3.4.1 removed the attribute but left this rendering `fault=…`
    // from a value that was never written — a permanently dead branch that
    // read as evidence the feature still existed. It returns under the same
    // condition the comment set at the time: a test publishes one for real.
    const fault = opState?.operationalError as
      | { errorStateId?: number }
      | undefined;
    // The generic codes cover many Roborock faults, so the id alone no longer
    // says what happened. The resolver's own text is re-read here rather than
    // threaded through the cluster, because the cluster carries only what
    // Matter defines.
    const faultDetail = this.getMatterFault()?.text ?? "";
    // The phase, named rather than numbered, and only when there is one.
    //
    // This field is here because the feature it reports is UNMEASURED: nobody
    // knows whether Apple Home draws a phase. Without it, someone looking at a
    // tile that says nothing during a dry cannot tell whether the controller
    // ignored the attribute or the plugin never sent it — which is exactly the
    // mistake that cost the tank warning 2 releases and 3 field tests.
    const phaseIndex = opState?.currentPhase;
    const phaseList = opState?.phaseList;
    const phaseText =
      typeof phaseIndex === "number" && Array.isArray(phaseList)
        ? `, phase=${phaseList[phaseIndex] ?? phaseIndex}`
        : "";
    const faultText =
      typeof fault?.errorStateId === "number" && fault.errorStateId !== 0
        ? `, fault=${fault.errorStateId} (${RVC_OPERATIONAL_ERROR_NAMES[fault.errorStateId] ?? "unnamed"}${
            faultDetail && faultDetail !== "Clean water tank empty"
              ? `: ${faultDetail}`
              : ""
          })`
        : "";

    return `Matter publish for ${this.getVacuumName()}: battery=${typeof halfPercent === "number" ? halfPercent / 2 + "%" : "n/a"}, operationalState=${opState?.operationalState ?? "n/a"}, runMode=${runMode?.currentMode ?? "n/a"}, cleanMode=${cleanMode?.currentMode ?? "n/a"}${phaseText}${faultText}.`;
  }

  /**
   * Log the publish evidence line whenever it would read differently from the
   * last one written.
   *
   * The line's stated purpose is to make an Apple Home display problem
   * diagnosable from a single log excerpt. It was emitted only when the
   * BATTERY value changed, which defeated that: a user in issue #8 sent a log
   * spanning a whole cleaning run in which every operational-state transition
   * was invisible, because the line only appeared on the four polls where the
   * battery happened to tick down. Comparing rendered lines — rather than a
   * hand-written list of interesting fields — means any value the line names
   * triggers it, including one added to the message later. A heartbeat's
   * forced republish of unchanged values still says nothing new, so the
   * self-healing full write stays silent at INFO.
   *
   * It is not silent at debug, and that gap cost issue #7 a round trip. A
   * docked robot at 100 % renders an identical line every time, so its publish
   * evidence appeared once at startup and never again — and the reporter was
   * asked to check whether these lines were still being written while his Apple
   * Home tile was dead. He looked, correctly found none in eleven minutes, and
   * the answer meant nothing: absence was what this method does, not evidence
   * that the plugin had stopped. "Is this plugin still publishing?" was
   * unanswerable from the log at any level. One debug line per suppressed
   * publish makes it answerable without spending a single INFO line, which is
   * the whole point of the deduplication above.
   */
  private logMatterPublishIfChanged(
    clusters: MatterClusterState,
    reason: string
  ): void {
    const line = this.buildMatterPublishLogLine(clusters);
    if (line === this.lastLoggedMatterPublishLine) {
      // Names the reason so the two liveness questions stay separable: the
      // 60-second heartbeat proves the Matter write path is still running, a
      // poll proves the Roborock side still answers.
      this.platform.log.debug(
        `${line} Unchanged since the last logged line, so it was written but not repeated at info (${reason}).`
      );
      return;
    }
    this.lastLoggedMatterPublishLine = line;
    this.platform.log.info(line);
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

  private async identifyVacuum(
    surface: string = MATTER_SURFACE
  ): Promise<void> {
    await this.publishCurrentMatterState(`${surface} identify command`, {
      clearOptimistic: true,
    });

    const findMe = this.api.find_me;
    if (typeof findMe !== "function") {
      this.platform.log.debug(
        `${surface} identify requested for ${this.getVacuumName()}, but the Roborock API does not expose find_me.`
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
        `Unable to locate ${this.getVacuumName()} from ${surfacePhrase(surface)} identify: ${this.getErrorMessage(error)}`
      );
    }

    await this.publishCurrentMatterState(
      `${surface} identify command complete`,
      {
        clearOptimistic: true,
      }
    );
  }

  private async changeRunMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();
    const duid = this.getDuid();

    this.platform.log.info(
      `Matter run mode request for ${name}: ${newMode ?? "unknown"}.`
    );

    if (newMode === RUN_MODE_CLEANING) {
      await this.startCleaning();
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

  /**
   * Start a clean.
   *
   * Shared by the Matter run-mode handler and the optional "Start Cleaning"
   * HAP switch, and deliberately so: the switch starts exactly the clean the
   * Home tile's play button would, including any rooms selected on that tile.
   * A switch with its own idea of what "start" means would be a second command
   * path, and the room selection it ignored would be the one the user is
   * looking at.
   */
  private async startCleaning(surface: string = MATTER_SURFACE): Promise<void> {
    const name = this.getVacuumName();
    const duid = this.getDuid();
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
          `Room cleaning across multiple Roborock maps was requested for ${name}; cleaning only the areas on map ${targetMapId}.`
        );
      }

      const selectedAreaNames = areasToClean.map((area) =>
        this.formatServiceAreaName(area)
      );
      this.platform.log.info(
        `Starting ${name} from ${surfacePhrase(surface)} for selected service area(s): ${selectedAreaNames.join(", ")}.`
      );
      const state = {
        rvcRunMode: { currentMode: RUN_MODE_CLEANING },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.RUNNING,
        },
      };
      this.beginServiceAreaProgress(areasToClean.map((area) => area.areaId));
      this.setAndScheduleOptimisticState(state, "selected-area start");
      this.dispatchRoborockMatterCommand(
        "service area clean",
        async () => {
          await this.applyCleanModeBeforeStarting();
          await this.loadMatterMapIfNeeded(duid, targetMapId);
          await this.api.app_segment_clean_by_ids(
            duid,
            areasToClean.map((area) => area.segmentId),
            this.getMatterCommandOptions()
          );
        },
        { surface }
      );
      return;
    }

    this.platform.log.info(`Starting ${name} from ${surfacePhrase(surface)}.`);
    const state = {
      rvcRunMode: { currentMode: RUN_MODE_CLEANING },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.RUNNING,
      },
    };
    this.beginFullCleanServiceAreaProgress();
    this.setAndScheduleOptimisticState(state, "start");
    this.dispatchRoborockMatterCommand(
      "start",
      async () => {
        await this.applyCleanModeBeforeStarting();
        await this.api.app_start(duid, this.getMatterCommandOptions());
      },
      { surface }
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
      // Discard the level remembered from the robot: from here on the user
      // has said what they want, and an unreadable fan power must fall back
      // to their choice rather than to what the robot said before it. The
      // applied-type pin goes for the same reason — it records an older
      // intent, and this selection supersedes it.
      this.lastResolvedFanPowerCleanMode = null;
      this.appliedCleanTypePin = null;
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

  private async pauseCleaning(surface: string = MATTER_SURFACE): Promise<void> {
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
        `Pausing ${this.getVacuumName()} from ${surfacePhrase(surface)} despite an idle snapshot; the cached state may be stale.`
      );
    } else {
      this.platform.log.info(
        `Pausing ${this.getVacuumName()} from ${surfacePhrase(surface)}.`
      );
    }
    const state = {
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.PAUSED,
      },
    };
    this.setAndScheduleOptimisticState(state, "pause");
    this.dispatchRoborockMatterCommand(
      "pause",
      () => this.api.app_pause(this.getDuid(), this.getMatterCommandOptions()),
      { surface }
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
      await this.applyCleanModeBeforeStarting();
      await this.api.app_start(this.getDuid(), this.getMatterCommandOptions());
    });
  }

  private async returnToDock(surface: string = MATTER_SURFACE): Promise<void> {
    // Always forward an explicit Matter dock to the robot. As with pause, the
    // cached snapshot can lag or be overridden by a stale HomeData refresh while
    // the robot is really cleaning (issues #4 and #12); docking an already-docked
    // robot is a harmless no-op.
    if (this.isDockedOrChargingNow()) {
      this.platform.log.info(
        `Sending ${this.getVacuumName()} back to dock from ${surfacePhrase(surface)} despite a docked snapshot; the cached state may be stale.`
      );
    } else {
      this.platform.log.info(
        `Sending ${this.getVacuumName()} back to dock from ${surfacePhrase(surface)}.`
      );
    }
    const returnOperationalState = this.isExtendedOperationalStateEnabled()
      ? RVC_OPERATIONAL_STATE.SEEKING_CHARGER
      : RVC_OPERATIONAL_STATE.STOPPED;
    const state = {
      rvcRunMode: {
        // Docking inherits the run mode instead of deciding one, the same rule
        // the live status follows. Deciding here published Cleaning for a dock
        // command sent to an idle robot — and only for users with Extended
        // Operational States on, because the decision read the displayed state
        // — which the next live frame then silently withdrew.
        currentMode: this.lastPublishedRunMode ?? this.lastRunMode,
      },
      rvcOperationalState: {
        operationalState: returnOperationalState,
      },
    };
    this.setAndScheduleOptimisticState(state, "return to dock");
    this.dispatchRoborockMatterCommand(
      "return to dock",
      () => this.api.app_charge(this.getDuid(), this.getMatterCommandOptions()),
      { retryReturnToDockIfStillActive: true, surface }
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
   * resync per boot first: the battery attributes are published as briefly
   * unknown and then with their real values, which makes two genuine store
   * changes and bumps the cluster data version, so a controller that reads
   * the cluster sees a new version instead of a value that has sat unchanged
   * since pairing day.
   *
   * It does NOT push the new percentage to a subscriber, and no bridge-side
   * write can. `PowerSource.batPercentRemaining` carries the Matter "changes
   * omitted" (C) quality, and the spec is explicit: such an attribute "SHALL
   * NOT have delta changes published as part of a Subscribe interaction".
   * matter.js implements that faithfully and closed the request to opt out of
   * it as works-as-intended (matter.js#4163, 28 July 2026), with the
   * maintainer noting that ecosystems are expected to poll these attributes
   * themselves. Apple Home does not, which is why the tile can hold the
   * percentage it was paired with. That is an Apple-side gap to report
   * through Apple's feedback process — do not reintroduce a workaround here.
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
    // The full snapshot as built, kept across the diff below so the evidence
    // line always reports every value — not just the clusters that changed.
    const snapshot = clusters;

    // Before the diff below, and before the early return it can take: this is
    // the one place every Roborock-driven state change passes through, so it is
    // the only hook that cannot miss one. The unchanged-payload path matters
    // just as much as the changed one — a listener's first reading after a
    // restart usually arrives on a poll whose clusters are byte-identical to
    // what the previous process already published.
    this.rememberPublishedRunMode(snapshot);
    this.notifyStateListener();

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
        this.logMatterPublishIfChanged(snapshot, reason);
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
    if (updated) {
      this.logMatterPublishIfChanged(snapshot, reason);
    }
    if (updated && resyncEligible) {
      this.powerSourceResyncDone = true;
      this.platform.log.debug(
        `Battery resync for ${this.getVacuumName()}: republished the battery attributes to bump their Matter data version (battery=${(power.batPercentRemaining as number) / 2}%).`
      );
    }

    return updated;
  }

  /**
   * Tell whoever asked that this robot's published state may have moved.
   *
   * A listener rather than a call into the platform's sensor map, so this class
   * stays unaware that read-only HAP sensors exist at all. The first draft did
   * reach into the platform, and the cost showed up immediately: seventeen test
   * suites build their own platform stand-in, and every one of them would have
   * had to grow a method about a feature it was not testing — with the next
   * stand-in forgetting it again. Nothing else in this file needs the platform
   * to own that knowledge, so it does not.
   */
  private notifyStateListener(): void {
    if (!this.stateListener) {
      return;
    }

    try {
      this.stateListener();
    } catch (error) {
      // A listener that throws must not take the Matter publish down with it.
      this.platform.log.debug(
        `State listener for ${this.getVacuumName()} failed: ${this.getErrorMessage(error)}`
      );
    }
  }

  /** Keep the run mode the state sensors answer from in step with Matter's. */
  private rememberPublishedRunMode(snapshot: MatterClusterState): void {
    const runMode = snapshot.rvcRunMode as Record<string, unknown> | undefined;
    const currentMode = runMode?.currentMode;
    if (typeof currentMode === "number") {
      this.lastPublishedRunMode = currentMode;
    }
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
    const dockErrorStatus = this.getNumberFromValue(status.dock_error_status);
    const waterShortageStatus = this.getNumberFromValue(
      status.water_shortage_status
    );
    const errorCode = this.getNumberFromValue(status.error_code);
    const dryStatus = this.getNumberFromValue(status.dry_status);

    // Fan power and clean type count as meaningful updates too. A suction or
    // mop-mode change made in the Roborock app (or chosen by SmartPlan) pushes
    // a frame carrying only that field; treating it as empty meant the Apple
    // Home clean-mode picker kept showing the previous level until some other
    // event happened to arrive. The publish below resolves the operational
    // state through getNumberStatus, which falls back to the remembered state,
    // so a frame without `state` does not reset the tile.
    //
    // Derived from MEANINGFUL_LIVE_STATUS_FIELDS rather than spelled out, so
    // this check and extractStatusUpdate's gate always name the same fields.
    const meaningfulValues: Record<
      (typeof MEANINGFUL_LIVE_STATUS_FIELDS)[number],
      number | null
    > = {
      state,
      charge_status: chargeStatus,
      battery,
      clean_area: cleanArea,
      clean_time: cleanTime,
      fan_power: fanPower,
      matter_clean_type: matterCleanType,
      dock_error_status: dockErrorStatus,
      water_shortage_status: waterShortageStatus,
      error_code: errorCode,
      dry_status: dryStatus,
    };
    if (
      MEANINGFUL_LIVE_STATUS_FIELDS.every(
        (field) => meaningfulValues[field] === null
      )
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
    // The tank fields, and this is why they have to be here.
    //
    // getNumberStatus reads the live cache first and the HomeData snapshot
    // second. These 2 fields are not in the snapshot, so if the live cache
    // does not remember them there is nowhere left to read them from and
    // isWaterTankEmpty() answers null forever. That is exactly what happened:
    // 3.10.0 shipped the Water Tank Empty sensor, 3.12.0 shipped the Matter
    // fault, both were correct, and neither could ever fire on a real robot
    // while the Roborock app showed "Out of water" on the same dock.
    //
    // The unit tests did not catch it because they stub
    // getVacuumDeviceStatus, so they proved the logic and nothing about the
    // plumbing.
    this.rememberLiveStatus("dock_error_status", dockErrorStatus);
    this.rememberLiveStatus("water_shortage_status", waterShortageStatus);
    // Same reasoning for the robot's own fault: a robot that gets stuck
    // mid-run announces it in a live frame, and the HomeData snapshot behind
    // it can be minutes old. Remembering it here is what makes a fault reach
    // the tile while the robot is still stuck rather than after the next
    // cloud refresh.
    this.rememberLiveStatus("error_code", errorCode);
    // Drying is a dock job, so it arrives while the robot itself is idle and
    // the frames are at their sparsest. Without the cache a single frame
    // carrying only `dry_status` would light the phase and the next heartbeat
    // would put it out again.
    this.rememberLiveStatus("dry_status", dryStatus);

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
      currentMode: this.resolveRunMode(),
    };
  }

  /**
   * The Matter run mode to publish.
   *
   * Apple Home treats RvcRunMode as the answer to "is this robot cleaning?":
   * it announces a cleaning that started when the mode goes to Cleaning and
   * one that finished when it goes back to Idle. A dock chore is neither.
   * Emptying the dust bin while the robot sat idle in its dock published
   * Cleaning and then Idle again, so the dock's own housekeeping announced a
   * cleaning that never happened (issue #9, Q Revo). The mirror image matters
   * just as much: a robot that empties its bin in the MIDDLE of a run must not
   * announce that the run finished and started again.
   *
   * So a dock chore inherits the run mode that was published before it began,
   * instead of deciding one of its own. Transit does the same, and for the same
   * reason: after the dock empties the bin the robot reports "returning to
   * dock" for about a second before it charges again, and publishing Cleaning
   * for that blip announced a second cleaning that started and finished from a
   * robot that never moved (issue #9, the reporter's follow-up). Driving home
   * is how a real run ENDS, never how one begins.
   *
   * Both are recognised from the robot's own state, not from the
   * controller-facing one: with "Extended Operational States" off, emptying
   * the dust bin is rewritten to RUNNING one level below and seeking the
   * charger to STOPPED, so reading that would leave the rule working only for
   * the users who enabled the toggle — which is exactly how the transit blip
   * survived 3.6.2 and reached the field. The toggle decides how a state is
   * displayed; it never decides whether a cleaning happened.
   */
  private resolveRunMode(): number {
    const roborockOperationalState = this.getRoborockOperationalState(
      this.getNumberStatus("state"),
      this.getNumberStatus("charge_status")
    );

    if (RUN_MODE_INHERITED_STATES.has(roborockOperationalState)) {
      return this.lastRunMode;
    }

    this.lastRunMode = this.isInCleaningRunMode(this.getOperationalState())
      ? RUN_MODE_CLEANING
      : RUN_MODE_IDLE;
    return this.lastRunMode;
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
          // Matter does have a dedicated tag for this -- VacuumThenMop, 0x4003 --
          // and this mode does not use it. Two reasons, both about other people's
          // homes rather than correctness: SupportedModes is fixed at commissioning,
          // so swapping the tag would make every existing robot need re-pairing
          // before its mode picker worked again; and Apple renders the tag rather
          // than the label, so the change is visible and would have to be worth it.
          // Combining the 2 standard tags is legal and is what ships today.
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
    return this.platform.platformConfig.enableFanPowerCleanModes !== false;
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
    const inCleaningRun = this.isInCleaningRunMode(this.getOperationalState());
    this.trackAppliedCleanTypeRun(inCleaningRun);

    // The wind-down is not a mode change, and on a classic robot it looks
    // exactly like one.
    //
    // Measured 20 Aug on an a70 asked to mop: it reported Mop while cleaning,
    // vacuum+mop the second it was sent home, then Mop again once docked —
    // 1, 2, 1 on a single run, with the user having asked for one thing. The
    // robot was fine. Sending it home resets its fan power while the water
    // box stays configured, and "fan not off plus water on" is precisely the
    // signature getLiveCleanType() reads as vacuum+mop.
    //
    // So the derivation is frozen from the moment the robot stops cleaning
    // the floor until the run formally ends. It stays authoritative while the
    // robot is actually working, because a mode genuinely changed in the
    // Roborock app mid-clean must still reach Apple Home — that is a real case
    // with a test of its own. A robot that reports its clean type directly is
    // unaffected either way: its answer is not a guess.
    //
    // 3.12.3 froze only the drive home, and that was too narrow by exactly
    // one dock. Measured on the same robot 3 hours later: the flap moved from
    // 16:56 to 21:09, from state 64 to state 68. The robot finished mopping
    // the hall, drove home with the type correctly held at Mop, and then
    // reported Vacuum + Mop the moment it reached the dock and started
    // washing its mop — because a dock washing a mop runs water with the fan
    // off and on again, which is the same signature read the same wrong way.
    //
    // Everything `isInCleaningRunMode` counts as part of a run except
    // actually running or paused IS the wind-down: driving home, emptying the
    // bin, washing the mop, updating the map. During those the fan power and
    // water box belong to the dock's business, not to what the user asked for.
    const operationalState = this.getOperationalState();
    const windingDown =
      inCleaningRun &&
      operationalState !== RVC_OPERATIONAL_STATE.RUNNING &&
      operationalState !== RVC_OPERATIONAL_STATE.PAUSED;

    if (!this.selectedCleanModeNeedsApply && inCleaningRun && !windingDown) {
      const liveCleanType = this.getLiveCleanType();
      if (
        liveCleanType !== null &&
        this.isSupportedCleanMode(liveCleanType) &&
        this.acceptLiveCleanType(liveCleanType)
      ) {
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
      // Same reason as above: the fan power the robot reports on its way home
      // is the one it reset to, not the one it cleaned with.
      !windingDown &&
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
          this.lastResolvedFanPowerCleanMode = liveMode.mode;
          return liveMode.mode;
        }
      }

      // The fan power could not be resolved to one of the announced levels
      // (nothing readable, or a value outside them such as 105 "off"). The
      // plugin does not know which level the robot is on — and `selected`,
      // which defaults to plain Vacuum, is not that knowledge. Reporting it
      // anyway made both Q7 robots flip between "Max Vacuum" and "Vacuum" in
      // Apple Home on every battery tick while docked (measured 11 Aug 2026,
      // ten pairs of publishes one second apart). Keeping the level last
      // actually read says nothing new instead of saying something untrue;
      // an explicit Apple Home selection clears it, so a user's choice is
      // never shadowed by a level read before they made it.
      if (
        this.lastResolvedFanPowerCleanMode !== null &&
        this.isSupportedCleanMode(this.lastResolvedFanPowerCleanMode)
      ) {
        return this.lastResolvedFanPowerCleanMode;
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

  /**
   * The base clean TYPE a Matter clean mode belongs to. Suction-level modes
   * are vacuum-family variants with a pinned fan power, so they reduce to
   * plain Vacuum; the three base types reduce to themselves.
   *
   * Both the settings builder and the applied-type bookkeeping need this
   * reduction. A second hand-written copy of it is how the two ends drift
   * apart — the most repeated defect in this codebase — so there is one.
   */
  private getBaseCleanType(cleanMode: number): number {
    return this.getFanPowerCleanMode(cleanMode) ? CLEAN_MODE_VACUUM : cleanMode;
  }

  /**
   * Whether a clean type derived from the robot's live status may be reported.
   *
   * It may not when it contradicts a clean type this plugin applied for the
   * run in progress and had acknowledged, and the robot has not yet caught up.
   * Measured in #8 (skmzwanke, Saros 10, 12 Aug 2026) — 114 seconds of Apple
   * Home showing a mode nobody asked for:
   *
   *   16:09:20  Applying Vacuum mode to Weebo before starting.
   *   16:09:20  ...acknowledged by Roborock in 791 ms via cloud
   *   16:09:22  Matter publish ... cleanMode=0   <- what was asked for
   *   16:09:29  Matter publish ... cleanMode=2   <- the robot's lagging water
   *   16:11:23  Matter publish ... cleanMode=0   <- it finally caught up
   *
   * The reading behind that `2` is the water-box level, and the prep path
   * already documents that this very reading lies in this very window — it
   * refuses to consult it when deciding whether to send. Publishing it as the
   * truth from the other end was the inconsistency, not the robot's lag.
   *
   * Same rule as 3.4.11: when the plugin does not know, it says nothing new
   * rather than something untrue. The pin is released the moment the robot's
   * own report agrees, so a clean type changed in the Roborock app mid-run is
   * still followed.
   */
  private acceptLiveCleanType(liveCleanType: number): boolean {
    const pin = this.appliedCleanTypePin;
    if (!pin) {
      return true;
    }

    if (this.getBaseCleanType(liveCleanType) === pin.cleanType) {
      this.appliedCleanTypePin = null;
      return true;
    }

    // Never silently: a robot that acknowledges the command and then ignores
    // it is a different and worse fault than a robot that lags, and the only
    // way to tell them apart is for this to be in the log without debug on.
    if (!pin.reported) {
      pin.reported = true;
      this.platform.log.warn(
        `Roborock still reports ${this.getCleanModeLabel(liveCleanType)} for ${this.getVacuumName()} after ${this.getCleanModeLabel(pin.cleanType)} was applied and acknowledged; Apple Home keeps showing the mode that was asked for until the robot's own report agrees.`
      );
    }

    return false;
  }

  /**
   * Follow the run a pinned clean type belongs to, and drop the pin when that
   * run ends so the next clean — which may be started from the Roborock app in
   * a completely different mode — is reported from the robot's own signal.
   *
   * The pin is deliberately NOT dropped before the run has been seen running:
   * a publish landing between the apply and the robot reporting that it has
   * started would otherwise release it before it had done anything at all.
   */
  private trackAppliedCleanTypeRun(inCleaningRun: boolean): void {
    const pin = this.appliedCleanTypePin;
    if (!pin) {
      return;
    }

    if (inCleaningRun) {
      pin.runObserved = true;
    } else if (pin.runObserved) {
      this.appliedCleanTypePin = null;
    }
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

  /**
   * Makes the robot match the clean mode Apple Home is displaying, before a
   * Matter-initiated start.
   *
   * This used to run only when the user had just CHANGED the mode — the flag
   * was set by the ChangeToMode handler and by nothing else. That left the
   * most ordinary case of all unhandled: the mode Home already shows is
   * usually the mode the user wants, so they never tap it, so no ChangeToMode
   * arrives, so nothing was sent and the robot ran in whatever mode it had
   * been left in. Measured in #8: a "Vacuum" start with no preceding mode
   * request sent no water command at all and the robot mopped, while the same
   * start one explicit tap later sent it and vacuumed.
   *
   * Starting a clean is a promise that the robot will run in the displayed
   * mode, so the mode is applied on every start, changed or not. It is
   * deliberately NOT skipped when the robot looks like it already matches:
   * the reading such a check would consult is exactly the one that lies — a
   * docked robot's water-box status read as plain Vacuum for the robot that
   * then mopped. The settings themselves preserve the user's levels (a
   * vacuum-family mode keeps the robot's current suction, a mop-family mode
   * its current water level), so applying pins the clean TYPE and nothing else.
   */
  private async applyCleanModeBeforeStarting(): Promise<void> {
    const applySettings = this.api.applyMatterCleanModeSettings;
    if (typeof applySettings !== "function") {
      this.selectedCleanModeNeedsApply = false;
      this.appliedCleanTypePin = null;
      return;
    }

    // Read the displayed mode ONCE. It is what is being promised to the user,
    // and the bookkeeping below has to record the same value that was sent.
    const cleanMode = this.getCurrentCleanMode();
    const settings = this.getRoborockCleanModeSettings(cleanMode);
    if (!settings) {
      this.selectedCleanModeNeedsApply = false;
      this.appliedCleanTypePin = null;
      return;
    }

    this.platform.log.info(
      `Applying ${this.getCleanModeLabel(cleanMode)} mode to ${this.getVacuumName()} before starting.`
    );
    try {
      const prep = await this.withCleanModePrepTimeout(
        applySettings.call(
          this.api,
          this.getDuid(),
          settings,
          this.getMatterCleanModePrepCommandOptions()
        )
      );
      // Resolving is not the same as landing. The prep sends up to three
      // commands and resolves either way, reporting at warn what the robot
      // never confirmed — so an apply can succeed as a call while the command
      // carrying the clean TYPE went unanswered, and then the robot keeps the
      // settings it already had. Measured in #8 (skmzwanke, Saros 10, 18 Aug
      // 2026): the water mode was unconfirmed, his Saros ran vacuum+mop over
      // rooms he had asked to be vacuumed, and the pin below made Apple Home
      // show Vacuum for the whole run. The plugin held the tile on a promise it
      // had already logged that it could not keep.
      //
      // Pinning is only defensible as KNOWN ground truth. When the prep says
      // the type went unconfirmed, nothing is known, and the rule from the
      // thrown-error path below applies unchanged: the robot's own report is
      // the only signal there is, so it keeps its authority. Silence here is
      // deliberate — the prep already warned, naming the settings it lost.
      if (prep && prep.cleanTypeConfirmed === false) {
        this.appliedCleanTypePin = null;
        return;
      }

      // Sent AND acknowledged, so this is known ground truth about the run
      // that is starting. It outranks a robot report that has not caught up.
      this.appliedCleanTypePin = {
        cleanType: this.getBaseCleanType(cleanMode),
        runObserved: false,
        reported: false,
      };
    } catch (error) {
      // Nothing was confirmed, so nothing is known: the robot's own report is
      // the only signal there is about this run, and it keeps its authority.
      this.appliedCleanTypePin = null;
      this.platform.log.warn(
        `Unable to apply ${this.getCleanModeLabel(cleanMode)} mode to ${this.getVacuumName()} before starting; continuing with the start command. ${this.getErrorMessage(error)}`
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
    const baseCleanMode = this.getBaseCleanType(cleanMode);

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
    const dockPhase = this.areDockPhasesEnabled()
      ? this.getCurrentPhase()
      : null;

    const cluster: Record<string, unknown> = {
      // The dock's own jobs, named. Both attributes are mandatory on this
      // cluster and nullable; they were null from 1.4.58 until 3.14.0, because
      // the version 1.4.58 removed had used phase changes as a refresh hack
      // and flapped them at every Apple Home hub in the house. The answer to
      // flapping is a list that never changes, not an empty one — so the list
      // is a module constant and only CurrentPhase moves.
      //
      // Whether Apple Home draws a phase is UNMEASURED. Drying the mop is the
      // reason to try: it runs for hours after every mop clean and the
      // specification gives it no operational state, so a phase is the only
      // place it can be expressed at all.
      // THE LIST IS PRESENT ONLY WHILE THERE IS A PHASE, AND THAT IS NOT A
      // STYLE CHOICE — matter.js refuses the write otherwise.
      //
      // `OperationalStateServer.#assertCurrentPhase` throws
      // ImplementationError on a null CurrentPhase whenever PhaseList is
      // non-empty: "Current phase null is out of bounds for phase list of
      // length 4". Homebridge swallows that throw, so the whole cluster write
      // is silently rejected and the controller keeps whatever it last
      // accepted. 3.14.0 shipped a constant list with a null phase whenever
      // the dock was idle, which is nearly always — so from the moment a robot
      // finished washing its mop, its operational state froze in Apple Home.
      // Measured on a real run: the tile read "Cleaning Mop" for 5 minutes
      // while the robot mopped the hall, and would have read it until the next
      // dock job.
      //
      // Null list plus null phase is the specification's own encoding for "the
      // current mode has no phases", so this is also the more faithful
      // reading. The anti-flap argument that made the list a constant still
      // holds and the constant is still the only source: the list either is
      // that constant or is absent, and never anything else.
      //
      // Order matters and is load-bearing. matter.js reads `this.state
      // .phaseList` while validating `currentPhase`, so phaseList MUST be
      // assigned first — leaving the list, then the index, in that order.
      phaseList: dockPhase === null ? null : [...RVC_PHASE_LIST],
      currentPhase: dockPhase,
      // Advertise operational state IDs without labels. Apple Home stops
      // commissioning ("Connecting" forever) when the list carries labels or
      // manufacturer-range IDs, so only bare IDs are exposed here.
      operationalStateList: this.getOperationalStateList().map(
        (operationalStateId) => ({ operationalStateId })
      ),
      operationalState,
    };

    // The Matter fault attribute (`operationalError`), for the one condition
    // that has ever been seen to render. On by default since 3.12.0; see below
    // for what that is worth and what it costs.
    if (this.isFaultAttributeEnabled()) {
      const fault = this.getMatterFault();
      // Null means neither the dock nor the robot has said. Publishing NoError
      // on their behalf would clear a warning nobody has contradicted, so an
      // unknown robot leaves the attribute exactly where it was.
      if (fault !== null) {
        cluster.operationalError = { errorStateId: fault.id };
      }
    }

    // WHY THIS IS NARROW, when the same attribute was withdrawn twice before.
    //
    // Three controlled tests on an S8 Pro Ultra with an empty clean water
    // tank settled it. Apple Home drew no warning when the fault was sent
    // beside a Charging state, and drew no warning when the fault was sent
    // beside a forced Error state either — while the tile went to a stuck
    // "Updating…" that needed a manual poke. Apple rendered no RVC
    // OperationalError in any of those tests, so publishing it is pure risk
    // for a benefit that has never once materialised. That is also why
    // 1.4.61 removed the plugin's original write. Do NOT explain this by
    // "bridged accessory": every robot here gets its own Matter node, which
    // is why each is scanned separately, so a bridge is never involved. #9
    // has the same attribute rendering correctly elsewhere; the condition
    // that separates the two cases is still unknown, and guessing at it has
    // cost this plugin two round trips already.
    //
    // What changed is the evidence, not the risk. #9 carries a screenshot of
    // this exact attribute rendered correctly — tap icon on the play button,
    // localised string — by the same controller that drew nothing for
    // Wazza151. So "Apple never renders it" is false, and the condition that
    // separates the two cases is still unknown.
    //
    // It has its own config key rather than riding on fault reporting, so it
    // can be switched off again without losing the Error state feature — the
    // mistake 3.3.0 made by bundling the two. The key is not on the settings
    // page: 3.12.0 removed that whole section because a page of switches
    // whose off position can brick an accessory is worse than no page.
    //
    // The operational state is deliberately NOT forced to Error along with
    // it. Wazza151's third test did exactly that and Apple still drew
    // nothing, so it buys nothing measured — and a robot in Error may be
    // refused a Start command, which is a real cost for a robot that is
    // docked, charging and perfectly able to vacuum without water.
    //
    // The Error operational STATE is a different matter and is still
    // reported below: Apple renders operational states perfectly well (the
    // same robot shows Charging, Docked, Emptying and Washing correctly), so
    // a robot stuck under the sofa can stop claiming it is Ready without
    // touching the attribute that causes trouble.

    return cluster;
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
      // The library logs the same transition one call earlier, with the
      // segment id and the count of unresolved positions. Two info lines
      // beginning "Live room for X" per room change is the busiest recurring
      // pair in a cleaning log and the second carries nothing extra.
      this.platform.log.debug(
        `Matter currentArea for ${this.getVacuumName()} set to ${this.formatServiceAreaName(area)}${
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
      this.platform.platformConfig.enableMatterExtendedOperationalStates !==
      false
    );
  }

  private isChargingDockedStateEnabled(): boolean {
    return (
      this.platform.platformConfig.enableMatterChargingDockedStates !== false
    );
  }

  /**
   * Report the Matter Error state when the robot has genuinely halted,
   * instead of showing Ready. On by default since 3.12.0. The cost is that a
   * robot in Error may be refused a Start command by the controller, which is
   * the right answer for a robot that cannot run; `false` in config.json
   * restores the old silence.
   */
  private isFaultReportingEnabled(): boolean {
    return this.platform.platformConfig.enableMatterFaultReporting !== false;
  }

  /**
   * Separate from fault reporting above on purpose.
   *
   * That setting means "a robot that has genuinely halted should say so
   * instead of showing Ready". An empty clean-water tank is not that: the
   * robot is docked, charging, and can vacuum all day. Folding the two
   * together would change what a setting already switched on by other people
   * does to their tile, which is how 3.3.0 got into trouble.
   */
  /**
   * The `operationalError` attribute as a whole, tank and robot alike.
   *
   * The config key still says "Tank" because that is what it gated when it was
   * introduced in 3.12.0 and renaming it would silently re-enable the
   * attribute for anyone who had turned it off. The switch is no longer on the
   * settings page either way; it survives for the person who needs to turn the
   * attribute off from config.json after it misbehaves on some controller.
   */
  private isFaultAttributeEnabled(): boolean {
    return (
      this.platform.platformConfig.enableMatterTankFaultReporting !== false
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
    const controllerState = this.toControllerOperationalState(operationalState);

    // Dock and tank conditions deliberately never raise ERROR. The 3.4.0
    // switch that let them do so was withdrawn: it made a robot that could
    // still vacuum look unstartable, and the warning it was supposed to
    // surface never appeared in Apple Home even once.
    return controllerState;
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
    // With Extended Operational States on, report the dock activities as
    // themselves. Only SEEKING_CHARGER used to survive this gate; EMPTYING_
    // DUST_BIN, CLEANING_MOP and UPDATING_MAPS fell through to the switch
    // below and were rewritten to RUNNING no matter what the user had
    // enabled — so the toggle silently delivered one of the four states it
    // promised, and "emptying" and "washing the mop" never reached Apple Home
    // in any released version (issue #5).
    if (
      this.isExtendedOperationalStateEnabled() &&
      EXTENDED_OPERATIONAL_STATES.has(operationalState)
    ) {
      return operationalState;
    }

    if (
      this.isChargingDockedStateEnabled() &&
      (operationalState === RVC_OPERATIONAL_STATE.CHARGING ||
        operationalState === RVC_OPERATIONAL_STATE.DOCKED)
    ) {
      // Report real charging/docked states so Apple Home shows
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
        // ERROR (3) is a member of even the basic advertised list, so
        // publishing it was always legal — it was downgraded to STOPPED
        // alongside the states that genuinely needed a gate, which is why a
        // robot stuck under the sofa has always read as "Ready" in Apple
        // Home. Report it for real once the user has opted in.
        //
        // Only Roborock states 9 (Charging Error) and 12 (In Error) reach
        // here, i.e. the robot's own claim that it has halted. Dock
        // consumables arrive through `dock_error_status` instead and never
        // touch the state, so a full waste-water tank does not make a robot
        // that can still vacuum look unstartable in Apple Home.
        return this.isFaultReportingEnabled()
          ? RVC_OPERATIONAL_STATE.ERROR
          : RVC_OPERATIONAL_STATE.STOPPED;
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

      // 120 is error_code. A B01/Q7 robot that hits a fault mid-run pushes a
      // frame carrying only this field, and until 3.13.0 it was dropped here —
      // the one transport on which a fault is most likely to arrive alone.
      if (Object.prototype.hasOwnProperty.call(dps, "120")) {
        status.error_code = dps["120"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "121")) {
        status.state = dps["121"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "122")) {
        status.battery = dps["122"];
      }
      // 123 is FAN POWER, not charge status. The Roborock v1 dps numbering is
      // 120 error_code, 121 state, 122 battery, 123 fan_power,
      // 124 water_box_mode, 125/126/127 main-brush/side-brush/filter life,
      // 133 charge_status — and this file's own consumables table uses
      // 125/126/127 for exactly those lives, which corroborates it.
      //
      // Reading 123 as charge_status meant that changing suction mid-clean
      // (from the Roborock app, a schedule, or SmartPlan) pushed a frame whose
      // only field was 123. That produced {charge_status: 102} with state
      // null, which falls through to the charging branch — so an actively
      // cleaning robot flipped to "Charging" in Apple Home.
      if (Object.prototype.hasOwnProperty.call(dps, "123")) {
        status.fan_power = dps["123"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "124")) {
        status.water_box_mode = dps["124"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "133")) {
        status.charge_status = dps["133"];
      }

      return Object.keys(status).length > 0 ? status : null;
    }

    const payload = Array.isArray(data) ? data : data ? [data] : [];
    const message = this.asRecord(payload[0]);
    if (!message) {
      return null;
    }

    // Every field the publish reads counts here, including `fan_power` and
    // `matter_clean_type`. This gate used to name five of the seven, so a frame
    // whose only field was one of the missing two was discarded here even
    // though the caller explicitly treats it as a meaningful update.
    const hasStatus = MEANINGFUL_LIVE_STATUS_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(message, field)
    );

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

  /**
   * Whether the robot is in its dock.
   *
   * charge_status is a TIEBREAKER for a state that does not answer the
   * question, never an override of one that does. It used to be an independent
   * sufficient condition (`|| !!chargeStatus`), which contradicted the rule
   * this file already applies one function below: getRoborockOperationalState()
   * consults charge_status only in its `default:` arm — a robot reporting
   * state 5 is RUNNING no matter what charge_status says.
   *
   * The two fields are not read at the same instant. A sparse live frame
   * carrying only dps 121 moves `state` while `charge_status` keeps whatever it
   * held before the robot left its dock, and getNumberStatus() falls back to
   * the slower HomeData snapshot for any field the live frame omits. So the
   * pair "state = Room Clean, charge_status = 1" is not a contradiction in the
   * robot; it is one fresh field beside one stale one, and letting the stale
   * one win made the plugin call a robot mid-run docked.
   *
   * Measured in issue #8 on a Saros 10, twice out of two attempts on different
   * versions: the plugin published operationalState=1 for eight minutes with a
   * falling battery and live room tracking moving between rooms, and still
   * logged "despite a docked snapshot" when the run was ended from Apple Home.
   * The log line was the visible half. The costly half was shouldRetryReturnToDock(),
   * which asks this first and gave up before it reached
   * isRoborockActivelyCleaningAwayFromDock() — so the dock-retry never armed for
   * exactly the robots whose charge_status lags.
   *
   * Reuses that predicate rather than listing the states again: a second
   * hand-written copy of a list is the most repeated defect in this codebase.
   */
  private isRoborockDockedOrCharging(
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    if (roborockState === 8 || roborockState === 100) {
      return true;
    }

    if (this.isRoborockActivelyCleaningAwayFromDock(roborockState)) {
      return false;
    }

    return !!chargeStatus;
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
    const surface = options.surface ?? MATTER_SURFACE;

    void command()
      .then(() => {
        this.logMatterCommandDuration(action, startedAt, surface);
        this.schedulePostCommandStatusRefresh(action);
      })
      .catch(async (error) => {
        if (this.isDeviceNotReadyError(error)) {
          // The command raced a plugin restart: Roborock login/device setup
          // has not finished yet. Log calmly, roll the optimistic state back,
          // and let the user retry once startup completes instead of showing
          // a scary error with a misleading stack.
          this.platform.log.warn(
            `${surface} ${action} command for ${this.getVacuumName()} arrived before the Roborock connection finished starting up. Try again in a few seconds. ${this.getErrorMessage(error)}`
          );
          await this.recoverMatterStateAfterFailedCommand(action);
          return;
        }

        if (this.isMatterCommandTimeoutError(error)) {
          this.platform.log.warn(
            `${surface} ${action} command for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`
          );
          this.schedulePostCommandStatusRefresh(action, {
            acknowledgementTimedOut: true,
          });
          if (options.retryReturnToDockIfStillActive) {
            this.scheduleReturnToDockRetry(command, surface);
          }
          return;
        }

        this.platform.log.error(
          `Error sending ${surface} ${action} command to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
        await this.recoverMatterStateAfterFailedCommand(action);
      });
  }

  private scheduleReturnToDockRetry(
    command: () => Promise<void>,
    surface: string = MATTER_SURFACE
  ): void {
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
              `Skipping ${surface} return to dock retry for ${this.getVacuumName()} because Roborock no longer reports active cleaning.`
            );
            return;
          }

          const startedAt = Date.now();
          this.platform.log.warn(
            `Retrying ${surface} return to dock command for ${this.getVacuumName()} because Roborock still reports active cleaning after the first command timed out.`
          );

          return command()
            .then(() => {
              this.logMatterCommandDuration(
                "return to dock retry",
                startedAt,
                surface
              );
              this.schedulePostCommandStatusRefresh("return to dock retry");
            })
            .catch(async (error) => {
              if (this.isMatterCommandTimeoutError(error)) {
                this.platform.log.warn(
                  `${surface} return to dock retry for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`
                );
                this.schedulePostCommandStatusRefresh("return to dock retry", {
                  acknowledgementTimedOut: true,
                });
                return;
              }

              this.platform.log.error(
                `Error sending ${surface} return to dock retry to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
              );
              await this.recoverMatterStateAfterFailedCommand(
                "return to dock retry"
              );
            });
        })
        .catch((error) => {
          this.platform.log.debug(
            `Unable to evaluate ${surface} return to dock retry for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
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

  private logMatterCommandDuration(
    action: string,
    startedAt: number,
    surface: string = MATTER_SURFACE
  ): void {
    const durationMs = Date.now() - startedAt;
    const transport = this.getTransportDescription();
    const message =
      `${surface} ${action} command for ${this.getVacuumName()} was acknowledged ` +
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
