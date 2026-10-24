import {
  setImmediate as nodeSetImmediate,
  setTimeout as nodeSetTimeout,
} from "node:timers";

import RoborockPlatform from "./platform";
import { getLiveMessageForThisAccessory } from "./live_message";
import { HomeKitActionKey, HomeKitStateSensorKey } from "./types";
import { clearTimer, scheduleTimer, unrefTimer } from "./timers";

const { getModelNameWithoutBrand } =
  require("../roborockLib/lib/deviceFeatures") as {
    getModelNameWithoutBrand: (model: unknown) => string | null;
  };

const MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS = 2000;
const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = 2500;
const MATTER_CLEAN_MODE_LIVE_CONFIRMATION_TIMEOUT_MS = 150 * 1000;

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
  context?: "before starting" | "during cleaning";
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
  app_start_collect_dust?(
    duid: string,
    options?: RoborockCommandOptions
  ): Promise<void>;
  supportsDustCollection?(duid: string): boolean;
  find_me?(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_segment_clean_by_ids(
    duid: string,
    segments: number[],
    options?: RoborockCommandOptions
  ): Promise<void>;
  resume_segment_clean?(
    duid: string,
    options?: RoborockCommandOptions
  ): Promise<void>;
  resume_zoned_clean?(
    duid: string,
    options?: RoborockCommandOptions
  ): Promise<void>;
  supportsSegmentResume?(duid: string): boolean;
  isB01Device?(duid: string): boolean;
  describeB01Fault?(
    duid: string,
    errorCode: number
  ): { id: number; roborock: string; spec?: string } | null;
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
  getLastKnownLiveStatus?(duid: string): unknown;
}

const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
// Live status entries older than this give way to the HomeData snapshot for
// the fields HomeData carries (see getNumberStatus).
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
//
// This list only decides WHETHER a frame is a status. What is remembered from
// an accepted frame is every numeric field it carries (rememberLiveStatusFrame),
// so a field read later can no longer be missing from a hand-written list.
// `water_box_mode` is here because the robot pushes it alone (dps 124) when the
// water level is changed in the Roborock app.
const MEANINGFUL_LIVE_STATUS_FIELDS = [
  "state",
  "charge_status",
  "battery",
  "clean_area",
  "clean_time",
  "fan_power",
  "water_box_mode",
  "matter_clean_type",
  "dock_error_status",
  "water_shortage_status",
  "dss",
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

const ALL_FAN_POWER_CLEAN_MODES = [
  ...FAN_POWER_CLEAN_MODES,
  MAX_PLUS_FAN_POWER_CLEAN_MODE,
];

const RVC_RUN_MODE_TAG_IDLE = 16384;
const RVC_RUN_MODE_TAG_CLEANING = 16385;
const RVC_CLEAN_MODE_TAG_VACUUM = 16385;
const RVC_CLEAN_MODE_TAG_MOP = 16386;

const ROBOROCK_FAN_POWER_OFF = 105;
const ROBOROCK_FAN_POWER_BALANCED = 102;
const ROBOROCK_WATER_BOX_OFF = 200;
const ROBOROCK_WATER_BOX_MILD = 201;

/**
 * Floor on how many DISTINCT live-room observations a room needs before the
 * plugin will call it visited. This is only a floor: the dwell below is what
 * actually separates cleaning a room from crossing it. See
 * `liveRoomVisit`.
 */
const LIVE_ROOM_READINGS_TO_CONFIRM = 2;

/**
 * How long the robot has to have been observed inside a room, continuously,
 * before the room counts as visited.
 *
 * This is the measurement that separates cleaning from crossing, and it is
 * sized against the two durations it has to tell apart rather than tuned:
 *
 * - A crossing is bounded by the room's own size divided by travel speed. A
 *   Roborock travels on the order of 0.3 m/s, so even a 10-metre traverse is
 *   about 35 seconds, and most are far shorter.
 * - Cleaning the smallest real room takes minutes, because the robot covers it
 *   in a boustrophedon pattern rather than a straight line.
 *
 * 90 seconds sits between the two with margin on both sides. It is also 9x the
 * 10-second live-room observation cadence, which matters for the reason this
 * project already wrote down for backoff constants: a gate on the same order
 * as the cadence that produced the failure does not gate anything. The
 * previous rule — 2 readings, nominally 10 to 20 seconds — was exactly that
 * gate, which is why vp-debug12 still saw crossed rooms marked cleaned.
 *
 * The failure direction is deliberate. A room that really was cleaned but
 * somehow missed the dwell falls back to Pending mid-run, and the end of the
 * run marks every requested area Completed anyway, so that mistake corrects
 * itself. The opposite mistake does not: it reports work the robot has not
 * done. When in doubt, under-confirm.
 */
const LIVE_ROOM_DWELL_TO_CONFIRM_MS = 90 * 1000;

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
 * The dock's code for "the dirty-water tank is full". python-roborock names it
 * (`v1_code_mappings.py`), and #22 caught it on the wire hiding a 38: the
 * field holds one code, and the dirty tank won.
 */
const DOCK_ERROR_DIRTY_WATER_TANK_FULL = 39;

/**
 * The robot's own `error_code` for the same two tanks (python-roborock
 * `RoborockErrorCode` 38 "check the clean water tank", 39 "check the dirty
 * water tank"). Same numbers as the dock codes, different field.
 */
const ROBOROCK_DOCK_TANK_ERROR_CODES: ReadonlySet<number> = new Set([38, 39]);

/** Bit offsets of the tank fields in the dock's `dss` status word. */
const DSS_CLEAN_WATER_SHIFT = 2;
const DSS_DIRTY_WATER_SHIFT = 4;
const DSS_CLEANING_FLUID_SHIFT = 10;
/** A `dss` tank field of 1: empty / full / not fitted. */
const DSS_TANK_NEEDS_ATTENTION = 1;
/**
 * `dock_type` values with no water tanks: 0 a plain charger, 1 and 5 the
 * auto-empty-only docks (python-roborock `_NO_DOCK_TYPES`,
 * `_PURE_COLLECT_DOCK_TYPES`).
 */
const DOCK_TYPES_WITHOUT_TANKS: ReadonlySet<number> = new Set([0, 1, 5]);

/**
 * The Matter cluster whose writes have to be ordered by hand. See
 * writeOperationalStateCluster().
 */
const OPERATIONAL_STATE_CLUSTER = "rvcOperationalState";

/** The part of Homebridge's `api.matter` this class writes through. */
type MatterStoreApi = {
  updateAccessoryState: (
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>
  ) => Promise<unknown>;
  getAccessoryState?: (
    uuid: string,
    cluster: string
  ) => Promise<Record<string, unknown> | undefined>;
};

/**
 * A Matter value in a form that compares equal however its keys came back.
 *
 * Homebridge's `getAccessoryState` hands back matter.js's own copy of a
 * struct, whose key order need not be the order this class built it in, and
 * which may carry optional fields as `undefined`.
 */
function canonicalMatterValue(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : inner
  );
}

function isSameMatterValue(a: unknown, b: unknown): boolean {
  return canonicalMatterValue(a) === canonicalMatterValue(b);
}

/**
 * The attributes of `wanted` the store does not already hold — all of them
 * when the store could not be read.
 */
function attributesTheStoreLacks(
  wanted: Record<string, unknown>,
  stored: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!stored) {
    return { ...wanted };
  }
  return Object.fromEntries(
    Object.entries(wanted).filter(
      ([attribute, value]) => !isSameMatterValue(value, stored[attribute])
    )
  );
}

/**
 * One turn of the event loop's check phase. Homebridge applies each
 * `updateAccessoryState` in a setImmediate (StateManager.js), so a publish
 * that waits for this before the next one reads the store back reads what it
 * wrote. node:timers' own function on purpose: it must be the real check
 * phase, also under a test's fake timers.
 */
function afterDeferredMatterWrites(): Promise<void> {
  return new Promise((resolve) => nodeSetImmediate(resolve));
}

/**
 * Roborock states that say the robot is busy with something Matter has no
 * operational state for (python-roborock `RoborockStateCode`): 28 in a call,
 * 30 egg attack, 32 patrol, 33/34 attaching/detaching the mop. They keep the
 * operational state the robot was last in (getRoborockOperationalState), the
 * way a dock chore keeps the run mode: DSimeone's a144 reports 33 with
 * `in_cleaning: 3` in the middle of a room clean (#22), and at an idle dock
 * after one.
 */
function isRoborockStateWithoutAMatterName(state: number): boolean {
  return (
    state === 28 || state === 30 || state === 32 || state === 33 || state === 34
  );
}

/** python-roborock's mopping states: 6301-6309 on the floor, 6310 heading home to wash. */
const ROBOROCK_MOPPING_STATE_FIRST = 6301;
const ROBOROCK_MOPPING_STATE_LAST_ON_THE_FLOOR = 6309;
const ROBOROCK_BACK_TO_DOCK_WASHING_DUSTER = 6310;

/** Idle (3) and Charger Disconnected (2): stopped, and not on the charger. */
function isRoborockOnTheFloorAtRest(state: number | null): boolean {
  return state === 2 || state === 3;
}

/** Driving to the dock: Returning (6), Docking (15), going to wash the mop. */
function isRoborockHeadingForTheDock(state: number | null): boolean {
  return (
    state === 6 ||
    state === 15 ||
    state === 26 ||
    state === ROBOROCK_BACK_TO_DOCK_WASHING_DUSTER
  );
}

function isRoborockMoppingOnTheFloor(state: number | null): boolean {
  return (
    state !== null &&
    state >= ROBOROCK_MOPPING_STATE_FIRST &&
    state <= ROBOROCK_MOPPING_STATE_LAST_ON_THE_FLOOR
  );
}

/** `in_cleaning` values that each have their own resume verb. */
const IN_CLEANING_ZONE = 2;
const IN_CLEANING_SEGMENT = 3;

/**
 * The operational states a fault may be published beside.
 *
 * In matter.js 0.17.9 there is no such thing as "Running with a warning".
 * `RvcOperationalStateServer#handleOperationalError` sets `operationalState`
 * to Error (3) the moment any `operationalError` other than NoError is
 * written, and emits the OperationalError event. Clearing the error does not
 * give the old state back; only a later `operationalState` write does, and
 * that write in turn wipes any error still standing (`#assertOperationalState`).
 *
 * So publishing a fault for a robot that is cleaning tells Apple Home it has
 * stopped. Issue #35 decoded exactly that off the wire: the plugin logged
 * Running with fault 68, the report carried operationalState 3, and the tile
 * said "Refill the water tank" while the robot mopped two rooms. A robot that
 * is working, paused or driving home from a run is not blocked by an empty
 * tank, so a fault is only raised beside one of these states. One already
 * standing is kept through housekeeping at an idle dock (canCarryAFault).
 */
const OPERATIONAL_STATES_THAT_CARRY_A_FAULT: ReadonlySet<number> = new Set([
  RVC_OPERATIONAL_STATE.STOPPED,
  RVC_OPERATIONAL_STATE.ERROR,
  RVC_OPERATIONAL_STATE.CHARGING,
  RVC_OPERATIONAL_STATE.DOCKED,
]);

/**
 * Matter's own RVC OperationalError codes.
 *
 * 68 is `WaterTankEmpty`, and it is the attribute Apple Home draws as a tap
 * icon on the play button with a localised "refill the water tank" — the one
 * value in this list measured rendering on real hardware (a70, iOS 26.0).
 * 0 is `NoError` and has to be published too: an error attribute that is only
 * ever written when something is wrong never clears.
 *
 * THE CODES ABOVE 71.
 *
 * The enum continues: LowBattery (72), CannotReachTargetArea (73),
 * DirtyWaterTankFull (74), DirtyWaterTankMissing (75), WheelsJammed (76),
 * BrushJammed (77) and NavigationSensorObscured (78). They came with RVC
 * Operational State cluster revision 3 in Matter 1.4.2 — the revision that
 * also added the dock states 0x43-0x46 this plugin publishes and Apple Home
 * draws — and matter.js 0.17.9, the build Homebridge 2.4.0 ships, defines and
 * accepts all of them (@matter/types rvc-operational-state ErrorState, enforced
 * by its ValueValidator). Whether Apple Home renders them is unmeasured.
 *
 * DirtyWaterTankFull is published, because nothing else can say it (#26). The
 * robot faults keep their ≤71 codes with the closer name in the log line,
 * until somebody looks at a tile with 76 on it. DirtyWaterTankMissing is not
 * published: no Roborock signal tells a missing dirty tank from a full one
 * (see isDirtyWaterTankFull).
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
  DIRTY_WATER_TANK_FULL: 74,
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
  [RVC_OPERATIONAL_ERROR.DIRTY_WATER_TANK_FULL]: "Dirty water tank full",
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
 * `spec` names the Matter 1.4.2 code (cluster revision 3) that would be more
 * accurate than the id actually sent, and is logged for the same reason: so
 * the next person can see what the mapping gave up and why.
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
// A robot that halts is the same: stuck under the sofa mid-run it has not
// finished, and at an idle dock it has not started. Deciding Idle for it told
// Apple Home a stuck robot had finished its run.
//
// The transit and chore members happen to match EXTENDED_OPERATIONAL_STATES.
// That is a coincidence of Roborock's state table, not a shared meaning — one
// says what a toggle may display, the other says what may claim a cleaning —
// so do not merge them.
const RUN_MODE_INHERITED_STATES: ReadonlySet<number> = new Set([
  ...DOCK_ACTIVITY_STATES,
  RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
  RVC_OPERATIONAL_STATE.ERROR,
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
const ROOM_CLEAN_STATE = 18;
const PAUSED_STATE = 10;
// Low-frequency safety net. Every publish reads the store back and writes
// only what differs, so this generates no Matter traffic unless the store
// actually drifted from the latest Roborock state (or a timed overlay, such
// as the optimistic state after a command, expired).
const MATTER_STATE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** The optimistic overlay a start, area clean or resume lays over the tile. */
function cleaningOptimisticState(): MatterClusterState {
  return {
    rvcRunMode: { currentMode: RUN_MODE_CLEANING },
    rvcOperationalState: { operationalState: RVC_OPERATIONAL_STATE.RUNNING },
  };
}

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
  private lastReportedRoomsWithoutAMap = "";
  // ONE stamp for the whole cache, deliberately. 3.35.0 tried one per field
  // and review found the cost: the tank fields arrive only with a full
  // get_status, so between status replies they expired while battery pushes
  // kept everything else fresh — the tank verdict went unknown, HomeData's
  // `error_code: 0` then read as "nothing wrong", the standing tank fault was
  // cleared and raised again on the next status: a second notification for
  // one empty tank, the very thing #9 and #26 were about. The same thing then
  // happened to the whole cache after 15 quiet minutes, until stale values
  // stopped giving way to HomeData for fields HomeData does not carry.
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
  /**
   * Driving through a room is not cleaning it.
   *
   * A room reached `liveConfirmedServiceAreaIds` on its FIRST detection, and
   * a confirmed room is reported Completed the moment the robot moves on. So
   * a robot crossing the hall to reach the bedroom marked the hall cleaned on
   * the way past — reported by vp-debug12 in #9, and exactly right.
   *
   * 3.19.7 answered this with a dwell of 2 consecutive readings, and
   * vp-debug12 reported the symptom unchanged. The rule was defeated twice
   * over, and both holes are worth naming because both are easy to reintroduce.
   *
   * 1. It counted CALLS, not observations. This method runs from the 15-second
   *    poll, the 60-second heartbeat and every pushed cloud message, while the
   *    live room itself is refetched at most every 10 seconds. Two calls inside
   *    one fetch window therefore read the SAME physical position sample twice
   *    and confirmed the room from it — a single sighting, counted double.
   * 2. Even with two genuinely distinct samples, 2 readings 10 seconds apart
   *    spans about as long as a crossing takes. The gate was the same order of
   *    magnitude as the thing it was filtering.
   *
   * So a visit is now measured the way the physical question is asked: over
   * distinct observations, identified by the reading's own `at` timestamp, and
   * over the elapsed time those observations span. A room is visited once it
   * has been seen at least `LIVE_ROOM_READINGS_TO_CONFIRM` times and the visit
   * spans at least `LIVE_ROOM_DWELL_TO_CONFIRM_MS`. Leaving the room ends the
   * visit, so time is never accumulated across separate passes.
   *
   * Elapsed time comes from the observations themselves rather than from
   * `Date.now()` at processing time: it is the interval the robot was actually
   * seen in the room, not the interval during which we happened to look.
   */
  // The current visit: the room, how many distinct readings saw the robot
  // in it, and the first and most recent of their timestamps (the dwell is
  // their difference). In-memory only, like liveConfirmedServiceAreaIds.
  private liveRoomVisit: {
    areaId: number;
    readings: number;
    firstSeenAt: number;
    lastSeenAt: number;
  } | null = null;
  private serviceAreaProgress: Array<{ areaId: number; status: number }> = [];
  // What the room list said before a Matter start announced its rooms, kept
  // until the robot is seen running. A start that fails, or that the robot
  // acknowledges and never acts on, puts it back: those rooms were not cleaned.
  private serviceAreaProgressBeforeStart: {
    currentArea: number | null;
    progress: Array<{ areaId: number; status: number }>;
  } | null = null;
  // Matter asked the robot to stop this run, so the rooms it was not seen
  // cleaning end Skipped rather than Completed.
  private serviceAreaStopRequested = false;
  private selectedCleanMode = CLEAN_MODE_VACUUM;
  private selectedCleanModeNeedsApply = false;
  private selectedCleanModeLiveConfirmationExpiresAt = 0;
  /**
   * Whether `selectedCleanMode` holds a choice or merely its initial value.
   *
   * The two are indistinguishable by value — the initial value IS Vacuum — and
   * the difference decides whether an empty clean-water tank is announced as a
   * blocking fault. See isVacuumOnlyModeChosen(). This never returns to false:
   * a choice, once made, remains the last thing the user said about this robot
   * for the life of the process.
   */
  private userSelectedCleanMode = false;
  // The run mode last decided by a state that was not a dock chore. Dock
  // chores inherit it instead of deciding one of their own — see
  // resolveRunMode(). Idle is the honest starting point: a plugin that boots
  // while the dock is emptying knows of no run in progress.
  private lastRunMode = RUN_MODE_IDLE;
  // The operational state the robot last reported through a state that has a
  // Matter name. A state without one (isRoborockStateWithoutAMatterName) keeps
  // it. Null until a live frame has said, so the default arm decides.
  private lastNamedRoborockOperationalState: number | null = null;
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
  // Clusters already named as missing from the registered endpoint.
  private readonly reportedClustersMissingFromEndpoint = new Set<string>();
  private returnToDockRetryPending = false;
  private matterStateHeartbeatTimer: ReturnType<typeof nodeSetTimeout> | null =
    null;
  // Serializes every Matter publish (live messages, refreshes, command
  // paths, the heartbeat). Each publish reads the store back and writes only
  // what differs, so it must not read while the previous publish's writes are
  // still queued in Homebridge — see updateMatterState().
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
    this.seedFromLastKnownLiveStatus(device.duid);
    // Before the registration defaults are built, so they carry it.
    this.restoreServiceAreaProgress();
    this.updateMetadata(device);
  }

  /**
   * Start from the status the robot has already reported, if there is one.
   *
   * Homebridge 2.4.0 registers an external accessory with the clusters built
   * here as the endpoint's initial state and restores nothing over them (its
   * cache is loaded after registration). Built from HomeData alone they said
   * nothing about the tanks, so a standing tank fault was raised again on the
   * first live status after every restart — one more notification (#26). The
   * first `get_status` is waited for before discovery, so it is usually known
   * by now; remembered without publishing, the defaults below carry it.
   */
  private seedFromLastKnownLiveStatus(duid: string): void {
    const status = this.asRecord(this.api.getLastKnownLiveStatus?.(duid));
    if (status) {
      this.rememberStatusFrame(status);
    }
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

  private getMatterCleanModeLiveCommandOptions(): RoborockCleanModePrepOptions {
    return {
      ...this.getMatterCleanModePrepCommandOptions(),
      context: "during cleaning",
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
    if (action === "empty") {
      return (
        typeof this.api.app_start_collect_dust === "function" &&
        typeof this.api.supportsDustCollection === "function" &&
        this.api.supportsDustCollection(this.getDuid())
      );
    }

    if (action === "locate") {
      return typeof this.api.find_me === "function";
    }

    return true;
  }

  /** Ask to be told after every publish. Null clears it. */
  setStateListener(listener: (() => void) | null): void {
    this.stateListener = listener;
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
      case "dirtyWaterTankFull":
        return this.isDirtyWaterTankFull();
      case "cleaningFluidEmpty":
        return this.isCleaningFluidEmpty();
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
   * A third robot added a third source in 3.35.0: the a144 (Saros 10R, #22)
   * carries each tank in its dock status word `dss`, and its single
   * `dock_error_status` showed 39 (dirty tank full) while the clean tank was
   * empty too. Where `dss` has a clean-water field it decides; where it does
   * not, the two fields above still do, exactly as before.
   *
   * Null when none of the three is present. That is not the same as "not empty":
   * an absent field is the robot declining to answer, and a sensor that
   * answered "full" on its behalf would be inventing the one reading a user
   * would act on. Null leaves the sensor at rest instead, and rest is Open.
   */
  private isWaterTankEmpty(): boolean | null {
    const dockError = this.getNumberStatus("dock_error_status");
    const shortage = this.getNumberStatus("water_shortage_status");
    const cleanTank = this.getDockTankField(DSS_CLEAN_WATER_SHIFT);

    // The dock's own word decides when it has a clean-water field, and that
    // is the 3.35.0 change (a 38 still wins over it, as it always has). `dock_error_status` holds one code at a time, so a full dirty
    // tank (39) hides an empty clean one (38): DSimeone's a144 sat with both
    // tanks in need for twenty minutes while the sensor read Open, because
    // the only code on the wire was 39 (#22). The `dss` word carries each
    // tank separately. And when it says the clean tank is fine, a lingering
    // `water_shortage_status` does not overrule it (#26, refilled and still
    // reported empty).
    if (
      dockError === DOCK_ERROR_CLEAN_WATER_TANK_EMPTY ||
      cleanTank === DSS_TANK_NEEDS_ATTENTION
    ) {
      return true;
    }
    if (cleanTank !== null) {
      return false;
    }

    if (dockError === null && shortage === null) {
      return null;
    }

    return shortage !== null && shortage !== 0;
  }

  /**
   * One 2-bit tank field out of the dock's `dss` word (python-roborock
   * `v1_containers.py`: clean water at bit 2, dirty water at 4, cleaning fluid
   * at 10). 1 means the tank needs attention — empty, full or not fitted,
   * depending on the tank — and any other value means it is fine, 0 included:
   * python-roborock reads a 0 clean- or dirty-water field as "okay". Reading
   * it as "not said" let a lingering `water_shortage_status` call a dock that
   * said "fine" empty (#26's "still empty after refilling").
   *
   * Null when there is no word or the word is 0 (a dock that reports none of
   * this), and for a cleaning-fluid field of 0, which python-roborock reads as
   * "not supported" — so the older signals still decide.
   */
  private getDockTankField(shift: number): number | null {
    const dss = this.getNumberStatus("dss");
    if (dss === null || dss === 0) {
      return null;
    }
    // python-roborock only reads the tank fields for docks that have tanks
    // (`is_washable`, `is_clean_fluid_auto_delivery_supported`). A plain
    // charger or an auto-empty-only dock has no clean-water tank, and a 1
    // read from its word would be a permanent "empty" for a tank that does
    // not exist.
    const dockType = this.getNumberStatus("dock_type");
    if (dockType !== null && DOCK_TYPES_WITHOUT_TANKS.has(dockType)) {
      return null;
    }
    const value = (dss >> shift) & 3;
    return value === 0 && shift === DSS_CLEANING_FLUID_SHIFT ? null : value;
  }

  /**
   * The dock's dirty-water tank is full (or missing). `dock_error_status` 39
   * says it on the docks that use it; the `dss` word says it on the ones that
   * carry it, separately from the clean tank. Neither tells full from
   * missing: python-roborock names the `dss` value 1 `full_not_installed` and
   * dock code 39 `waste_water_tank_full`, "check tank placement or empty as
   * required". So it goes to Matter as DirtyWaterTankFull either way.
   */
  private isDirtyWaterTankFull(): boolean | null {
    const dockError = this.getNumberStatus("dock_error_status");
    const dirtyTank = this.getDockTankField(DSS_DIRTY_WATER_SHIFT);

    if (
      dockError === DOCK_ERROR_DIRTY_WATER_TANK_FULL ||
      dirtyTank === DSS_TANK_NEEDS_ATTENTION
    ) {
      return true;
    }
    if (dirtyTank !== null) {
      return false;
    }
    return dockError === null ? null : false;
  }

  /**
   * The cleaning-fluid (detergent) cartridge is empty or missing. Only docks
   * with automatic detergent dosing report it, and only in `dss` — there is
   * no `dock_error_status` code for it. Asked for in #22.
   */
  private isCleaningFluidEmpty(): boolean | null {
    const fluid = this.getDockTankField(DSS_CLEANING_FLUID_SHIFT);
    return fluid === null ? null : fluid === DSS_TANK_NEEDS_ATTENTION;
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
    if (tankEmpty === true && !this.isVacuumOnlyModeChosen()) {
      return {
        id: RVC_OPERATIONAL_ERROR.WATER_TANK_EMPTY,
        text: "Clean water tank empty",
      };
    }
    // Second, and for the same reasons as the clean tank: the dock cannot wash
    // a mop with nowhere to put the water, and a vacuum-only run does not
    // need it. 68 wins when both are flagged — one fault at a time, and 68
    // is the one measured rendering on a tile.
    const dirtyTankFull = this.isDirtyWaterTankFull();
    if (dirtyTankFull === true && !this.isVacuumOnlyModeChosen()) {
      return {
        id: RVC_OPERATIONAL_ERROR.DIRTY_WATER_TANK_FULL,
        text: "full, or not fitted: the dock does not tell them apart",
      };
    }
    const tankKnown = tankEmpty !== null || dirtyTankFull !== null;

    const errorCode = this.getNumberStatus("error_code");
    // Which numbering `error_code` is in is asked, not inferred: a Q7 answer
    // that omitted `mode` used to read as v1. The inference stays only for an
    // API that cannot answer.
    const isB01 = this.api.isB01Device?.(this.getDuid());
    const speaksV1 =
      isB01 === undefined
        ? this.getNumberStatus("matter_clean_type") === null
        : !isB01;
    if (
      errorCode !== null &&
      speaksV1 &&
      ROBOROCK_DOCK_TANK_ERROR_CODES.has(errorCode)
    ) {
      // "Check the clean / dirty water tank" (python-roborock 38, 39). The
      // robot pulses these for a few seconds while the dock reports the same
      // tank through `dock_error_status` and `dss`, which is what the tank
      // fault above is built from. Known, so not reported as unmapped — #22
      // was asked to report all three pulses — and not a second fault.
      return tankKnown
        ? { id: RVC_OPERATIONAL_ERROR.NO_ERROR, text: "" }
        : null;
    }
    if (errorCode !== null && errorCode !== 0 && !speaksV1) {
      // A B01 robot's `fault` field lingers after the event that set it, and
      // Home Assistant reads a B01 robot's state from its work status alone:
      // charging, drying and the dock chores are Docked (vacuum.py
      // Q7_STATE_CODE_TO_STATE / Q10_STATE_CODE_TO_STATE). A robot in its
      // dock is therefore not faulted, and saying so clears a code left
      // standing from before it got there — a Q7 lifted mid-run and carried
      // home read Stuck at the dock until something overwrote the field.
      const robotState = this.getRoborockOperationalState(
        this.getNumberStatus("state"),
        this.getNumberStatus("charge_status")
      );
      if (
        robotState === RVC_OPERATIONAL_STATE.CHARGING ||
        robotState === RVC_OPERATIONAL_STATE.DOCKED ||
        robotState === RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN ||
        robotState === RVC_OPERATIONAL_STATE.CLEANING_MOP
      ) {
        return { id: RVC_OPERATIONAL_ERROR.NO_ERROR, text: "" };
      }
    }
    if (
      errorCode !== null &&
      errorCode !== 0 &&
      !this.isFaultReportingEnabled()
    ) {
      // "Report faults" off promises a halted robot keeps reading Ready, and
      // in matter.js 0.17.9 any fault written here forces the Error state —
      // so the robot's own fault is not published either. The tank has its
      // own setting and was decided above.
      return { id: RVC_OPERATIONAL_ERROR.NO_ERROR, text: "" };
    }
    if (errorCode !== null && errorCode !== 0) {
      // The table is Roborock's v1 numbering. A B01 robot's `fault` field is
      // a different space entirely — 407, 2105 — so its codes are classified
      // by the protocol library in the robot's own family numbering.
      const mapped = speaksV1
        ? ROBOROCK_ERROR_TO_MATTER.get(errorCode)
        : this.api.describeB01Fault?.(this.getDuid(), errorCode) ?? undefined;
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

    if (tankKnown || errorCode === 0) {
      // At least one source affirmatively says it is fine and neither says
      // otherwise. Requiring both to be known would mean a robot that never
      // reports `error_code` could never clear a tank warning after a refill,
      // which is worse than no warning at all.
      //
      // `tankEmpty === true` reaches here only when the run was ruled to use
      // no water above, and then NoError is the affirmative answer rather
      // than an invention: the tank is known, and it is known not to block
      // anything. Going quiet instead would leave a 68 standing in the Matter
      // store, and Apple Home re-notifies about a blocking condition for as
      // long as it stands — which is the loop reported in issue #9.
      return { id: RVC_OPERATIONAL_ERROR.NO_ERROR, text: "" };
    }

    // Neither source has said anything.
    return null;
  }

  /**
   * Whether something has affirmatively said this robot is not going to use
   * water.
   *
   * WHY THE TANK FAULT NEEDS THIS AT ALL. Apple Home does not draw
   * `operationalError` as a passive warning — it draws WaterTankEmpty as a
   * BLOCKING condition and says so in words. vp-debug12's screenshot in issue
   * #9: "Rellena el depósito de agua — 'Roborock Qrevo' empezará a limpiar
   * cuando se llene el depósito de agua." It is a push notification, not tile
   * decoration (Wazza151 confirmed the same on an a70 in #5), and it repeated
   * every 2 minutes while his robot was set to Vacuum. On a vacuum-only run
   * every word of it is false: the robot is not waiting for water and will not
   * start cleaning when the tank is filled. So this is not a preference about
   * when a warning is welcome — the plugin was asserting a block that did not
   * exist.
   *
   * WHERE THE 2-MINUTE REPEAT CAME FROM. It was us, and for three releases
   * this comment said it could not be. The old text is worth keeping as a
   * warning about the measurement, not just the conclusion: it read "measured
   * against matter.js 0.18.0-alpha, the build Homebridge ships … no timer in
   * this plugin can produce a 68 -> 0 -> 68 cycle". The measurement was
   * sound. The premise was not — Homebridge 2.4.0 ships @matter/main 0.17.9,
   * not 0.18.0-alpha, and in 0.17.9 a write of `operationalState` clears a
   * standing `operationalError` — even a write of the value the plugin had
   * last sent, because the store was really holding Error (3.35.0 found why:
   * the fault itself forces Error; see OPERATIONAL_STATES_THAT_CARRY_A_FAULT).
   * The 60-second heartbeat re-writes the whole cluster, so the plugin was
   * clearing the fault and re-raising it once a minute, and matter.js emits
   * the cluster's `OperationalError` event on the 0 -> 68 edge: one
   * notification per two heartbeats. Two minutes.
   *
   * Fixed in 3.30.0 by writing the two attributes apart and never re-writing
   * an unchanged `operationalState`; the measurement table is in
   * writeOperationalStateCluster(). What remains true below is the part about
   * the tank reading and the authority flapping — those are the robot's own
   * data moving, and they are still the two ways a genuine repeat can happen.
   *
   * BUT THERE ARE EXACTLY TWO WAYS IT CAN STILL FLAP, and the second one is
   * easy to miss because it is not in isWaterTankEmpty() at all. First, the
   * tank reading itself flipping. Second — and this is the one vp-debug12
   * described in #9 as "changes to ready momentarily and then activates the
   * water error" — the AUTHORITY below switching. Which branch decides depends
   * on the robot's live state, so a robot dipping in and out of a run state
   * hands the decision back and forth between its own report and the user's
   * selection, and when those two disagree the fault tracks the oscillation.
   * Neither path is timed; both are the robot's own data moving.
   *
   * The log settles which, if any, is happening, but read it knowing that the
   * "Matter publish for …" line is de-duplicated against the previous rendered
   * line (lastLoggedMatterPublishLine): a steady fault appears ONCE and then
   * the log goes quiet, so repeated identical lines are not what a stuck fault
   * looks like. A flap looks like the `, fault=68 …` segment appearing and
   * disappearing between lines — a cleared fault renders as no fault segment
   * rather than as `fault=0`.
   *
   * AND DO NOT GATE THIS ON "A RUN WAS REQUESTED" EITHER, however tempting —
   * in a mopping mode the sentence is still not quite true for a parked robot.
   * Wazza151's confirmed case in #5 is a docked, idle robot with an empty
   * tank, which is precisely the case such a gate would silence. Warning about
   * an empty tank while the robot is parked is the point of the warning.
   *
   * WHY "VACUUM IS SELECTED" IS NOT THE TEST. `selectedCleanMode` is not
   * persisted: it starts at CLEAN_MODE_VACUUM on every restart (measured 20
   * Aug), so reading it directly would silence the tank warning on every robot
   * until somebody happened to touch the mode picker — quietly undoing the one
   * field-verified thing this attribute does. Only a mode somebody actually
   * said counts: the robot's own report while it is genuinely cleaning, the
   * user's selection outside that. The wind-down is excluded for the same
   * reason getCurrentCleanMode() excludes it — a dock washing a mop runs water
   * with the fan off and on again, which reads as vacuum+mop and is nothing of
   * the sort.
   *
   * WHERE THIS DELIBERATELY DIFFERS FROM getCurrentCleanMode(), because the
   * difference looks like an oversight and is not: there, an acknowledged
   * Matter selection stays visible while the robot's status catches up. Here
   * the applied-type pin below is the authority during that same window, so a
   * stale water report cannot invent a tank warning for water the robot has
   * already acknowledged turning off.
   *
   * The derived type goes through acceptLiveCleanType() like every other
   * consumer of it, and that gate is right here for the same reason it is
   * right there: a robot whose water this plugin has already turned off and
   * had acknowledged is not using water, however long its own report takes to
   * agree. Announcing a block during that window would be the lag talking.
   *
   * The HAP `Water Tank Empty` sensor is deliberately NOT gated by this. It
   * states a fact about the tank, makes no claim about what the robot is going
   * to do, and automations are built on it.
   */
  private isVacuumOnlyModeChosen(): boolean {
    const operationalState = this.getOperationalState();
    const inCleaningRun = this.isInCleaningRunMode(operationalState);
    const windingDown =
      inCleaningRun &&
      operationalState !== RVC_OPERATIONAL_STATE.RUNNING &&
      operationalState !== RVC_OPERATIONAL_STATE.PAUSED;

    if (inCleaningRun && !windingDown) {
      const liveCleanType = this.getLiveCleanType();
      if (liveCleanType !== null && this.acceptLiveCleanType(liveCleanType)) {
        return this.getBaseCleanType(liveCleanType) === CLEAN_MODE_VACUUM;
      }
    }

    if (this.userSelectedCleanMode) {
      return (
        this.getBaseCleanType(this.selectedCleanMode) === CLEAN_MODE_VACUUM
      );
    }

    // Nothing has said. An unknown mode must not silence a real warning.
    return false;
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
   *
   * WHY THE LINE NAMES THE ROBOT'S STATE, AND IT IS A MEASUREMENT RATHER THAN
   * A PREFERENCE. On 28 Aug 2026 the maintainer's 2 B01/sc05 robots produced 3
   * distinct unmapped codes in a single log, and every one of them turned out
   * to be tied to a state transition rather than to a fault: 2105 only while
   * docked and charging at 100 %, 2110 one second after a run started
   * (operationalState 1), 2104 on the way back to the dock
   * (operationalState 64). Nothing was wrong with any of the 3 robots at any
   * point — the run completed and they docked.
   *
   * Establishing that took hand-correlating each code against the neighbouring
   * `Matter publish for …` lines in a 2574-line log, because the line itself
   * carried only a number. A user filing a model report pastes the one line,
   * so the context that makes the number mappable never arrives — and this
   * plugin has 4 open model issues whose whole content is data like this.
   *
   * It also makes the line's own question answerable. "If the robot really is
   * in trouble right now" is unanswerable from a bare number, and asking it
   * while the robot is demonstrably cleaning normally invites a false report.
   *
   * The dedupe key stays the code alone rather than code-and-state. Keying on
   * both would name a lingering code once per transition it survives, which is
   * exactly the per-poll burial the "once" above exists to prevent; today's 3
   * codes each appeared in exactly 1 state, so the extra key would have bought
   * nothing and risked the guarantee.
   */
  private reportUnmappedErrorCode(errorCode: number): void {
    if (this.reportedUnmappedErrorCodes.has(errorCode)) {
      return;
    }
    this.reportedUnmappedErrorCodes.add(errorCode);
    const robotState = this.getNumberStatus("state");
    this.platform.log.info(
      `${this.getVacuumName()} reports error_code ${errorCode} while its state is ` +
        `${robotState ?? "unknown"} (Matter operationalState ${this.getOperationalState()}), ` +
        "which this plugin has no mapping for. " +
        "Nothing is published to Apple Home for it, because an unrecognised code is as likely to be " +
        "informational as it is to be a fault. If the robot really is in trouble right now, please report " +
        "the number, the state named above, and what the Roborock app says: " +
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
      case "empty":
        await this.emptyDustBin(HOME_SWITCH_SURFACE);
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
    // Nothing has been stated about the new node yet, so the evidence line is
    // restated for it instead of being suppressed as unchanged.
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
    // De-branded, because `manufacturer` two lines up already says Roborock
    // (#10). The last-resort string keeps the brand on purpose: it is a
    // placeholder for "we know nothing", not a model name.
    this.accessory.model =
      getModelNameWithoutBrand(reportedModel) ||
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
    this.accessory.clusters = this.asRegistrationDefaults(this.buildClusters());
    this.accessory.handlers = this.buildHandlers();
  }

  async notifyDeviceUpdater(id: string, data: unknown): Promise<void> {
    if (id === "HomeData" || id === "RoomMapping") {
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
    const matterFault = this.getMatterFault();
    const faultDetail = matterFault?.text ?? "";
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
    // A fault the robot has but the tile is not shown, because the robot is
    // working (see OPERATIONAL_STATES_THAT_CARRY_A_FAULT). Said in the line so
    // a log reader can tell "held back" from "never noticed".
    const heldBackText =
      faultText === "" &&
      typeof opState?.operationalState === "number" &&
      !this.canCarryAFault() &&
      matterFault !== null &&
      matterFault.id !== RVC_OPERATIONAL_ERROR.NO_ERROR &&
      this.isFaultAttributeEnabled()
        ? `, fault=${matterFault.id} held back while the robot works`
        : "";

    return `Matter publish for ${this.getVacuumName()}: battery=${typeof halfPercent === "number" ? halfPercent / 2 + "%" : "n/a"}, operationalState=${opState?.operationalState ?? "n/a"}, runMode=${runMode?.currentMode ?? "n/a"}, cleanMode=${cleanMode?.currentMode ?? "n/a"}${phaseText}${faultText}${heldBackText}.`;
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
   * republish of unchanged values still says nothing new, so it stays silent
   * at INFO.
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
          await this.selectServiceAreas(request?.newAreas);
        },
      };
    }

    return handlers;
  }

  private async identifyVacuum(
    surface: string = MATTER_SURFACE
  ): Promise<void> {
    // The optimistic overlay is left alone: locating a robot says nothing
    // about whether it is starting, and clearing it snapped the tile back to
    // Docked after a Start the robot had not reported yet (#4).
    await this.publishCurrentMatterState(`${surface} identify command`);

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
      `${surface} identify command complete`
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
      this.serviceAreaStopRequested = true;
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
      const state = cleaningOptimisticState();
      this.rememberServiceAreaProgressBeforeStart();
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
    const state = cleaningOptimisticState();
    this.rememberServiceAreaProgressBeforeStart();
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

    if (!this.isSupportedCleanMode(newMode)) {
      this.platform.log.warn(
        `Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`
      );
      return;
    }

    const previousSelection = {
      selectedCleanMode: this.selectedCleanMode,
      selectedCleanModeNeedsApply: this.selectedCleanModeNeedsApply,
      selectedCleanModeLiveConfirmationExpiresAt:
        this.selectedCleanModeLiveConfirmationExpiresAt,
      userSelectedCleanMode: this.userSelectedCleanMode,
      lastResolvedFanPowerCleanMode: this.lastResolvedFanPowerCleanMode,
      appliedCleanTypePin: this.appliedCleanTypePin,
    };

    // These are robot-reported preferences, not speculative selection
    // bookkeeping. If the command fails they remain valid pre-command truth,
    // so the rollback below intentionally does not restore them.
    this.rememberCurrentRoborockCleanModeSettings();
    this.selectedCleanMode = newMode;
    this.selectedCleanModeNeedsApply = true;
    this.selectedCleanModeLiveConfirmationExpiresAt = 0;
    this.userSelectedCleanMode = true;
    // Discard the level remembered from the robot: from here on the user has
    // said what they want, and an unreadable fan power must fall back to their
    // choice rather than to what the robot said before it.
    this.lastResolvedFanPowerCleanMode = null;
    this.appliedCleanTypePin = null;

    const operationalState = this.getOperationalState();
    const canApplyLive =
      operationalState === RVC_OPERATIONAL_STATE.RUNNING ||
      operationalState === RVC_OPERATIONAL_STATE.PAUSED;

    try {
      if (canApplyLive) {
        await this.applyCleanModeDuringRun(newMode);
      }
    } catch (error) {
      this.selectedCleanMode = previousSelection.selectedCleanMode;
      this.selectedCleanModeNeedsApply =
        previousSelection.selectedCleanModeNeedsApply;
      this.selectedCleanModeLiveConfirmationExpiresAt =
        previousSelection.selectedCleanModeLiveConfirmationExpiresAt;
      this.userSelectedCleanMode = previousSelection.userSelectedCleanMode;
      this.lastResolvedFanPowerCleanMode =
        previousSelection.lastResolvedFanPowerCleanMode;
      this.appliedCleanTypePin = previousSelection.appliedCleanTypePin;
      throw error;
    }

    this.setAndScheduleOptimisticState(
      { rvcCleanMode: { currentMode: newMode } },
      "clean mode change"
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

  /**
   * Which verb continues the clean the robot has paused, read from its own
   * `in_cleaning` (python-roborock `RoborockInCleaning`):
   *
   *   0  complete ........................ app_start
   *   1  whole-home clean not complete ... app_start
   *   2  zone clean not complete ......... resume_zoned_clean
   *   3  room (segment) clean not complete resume_segment_clean
   *
   * 3.34.0 sent `resume_segment_clean` for ANY non-zero value, which turned
   * the play button on a paused whole-home clean — the case CooperCGN had
   * confirmed already worked in #28 — into a room-clean resume, and sent the
   * room verb to a paused zone clean. The repo's own captured payload of a
   * room clean carries 3 (`roborockAPI.test.js`), which is the one value
   * that verb belongs to. Home Assistant's Roborock integration makes the
   * same three-way choice.
   *
   * `state` cannot answer this: a paused robot reports 10 and the clean type
   * is gone from it, while `in_cleaning` survives the pause. Read from the
   * robot rather than remembered here, deliberately. A flag set when Matter
   * started the run would be wrong for a room clean started in the Roborock
   * app, wrong after a Homebridge restart, and wrong the first time someone
   * paused from a third surface — and being wrong in this particular place
   * means sending a resume verb into a full clean. An absent or unreadable
   * value is treated as a full clean.
   */
  private getResumeVerb():
    | "app_start"
    | "resume_segment_clean"
    | "resume_zoned_clean" {
    if (this.api.supportsSegmentResume?.(this.getDuid()) === false) {
      return "app_start";
    }

    const inCleaning = this.getNumberStatus("in_cleaning");
    if (
      inCleaning === IN_CLEANING_SEGMENT &&
      typeof this.api.resume_segment_clean === "function"
    ) {
      return "resume_segment_clean";
    }
    if (
      inCleaning === IN_CLEANING_ZONE &&
      typeof this.api.resume_zoned_clean === "function"
    ) {
      return "resume_zoned_clean";
    }
    return "app_start";
  }

  private async resumeCleaning(): Promise<void> {
    // Matter's Resume has always been `app_start`. That is right for a paused
    // FULL clean and wrong for a paused ROOM or ZONE clean, where it starts a
    // new whole-home run instead of continuing the one that was interrupted
    // (#28). See getResumeVerb() for which verb goes with which clean.
    const verb = this.getResumeVerb();

    this.platform.log.info(
      verb === "resume_segment_clean"
        ? `Resuming the paused room clean on ${this.getVacuumName()} from Matter.`
        : verb === "resume_zoned_clean"
          ? `Resuming the paused zone clean on ${this.getVacuumName()} from Matter.`
          : `Resuming ${this.getVacuumName()} from Matter.`
    );
    this.platform.log.debug(
      `Resume for ${this.getVacuumName()}: in_cleaning=${this.getNumberStatus("in_cleaning") ?? "unknown"}, sending ${verb}.`
    );
    const state = cleaningOptimisticState();
    this.setAndScheduleOptimisticState(state, "resume");
    this.dispatchRoborockMatterCommand("resume", async () => {
      await this.applyCleanModeBeforeStarting();

      if (verb === "resume_segment_clean" || verb === "resume_zoned_clean") {
        // No fallback to `app_start` if this fails. A failed resume leaves a
        // paused robot paused, and the user presses play again; falling back
        // would silently produce the exact whole-home run #28 is about.
        await this.api[verb]!(this.getDuid(), this.getMatterCommandOptions());
        return;
      }

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

  private async emptyDustBin(surface: string): Promise<void> {
    if (!this.isDockedOrChargingNow()) {
      this.platform.log.info(
        `Emptying ${this.getVacuumName()}'s dust bin from ${surfacePhrase(surface)} despite a snapshot that does not show it docked; the cached state may be stale.`
      );
    } else {
      this.platform.log.info(
        `Emptying ${this.getVacuumName()}'s dust bin from ${surfacePhrase(surface)}.`
      );
    }

    const startDustCollection = this.api.app_start_collect_dust;
    if (typeof startDustCollection !== "function") {
      this.platform.log.warn(
        `Not emptying ${this.getVacuumName()} from ${surfacePhrase(surface)} because the auto-empty command is unavailable.`
      );
      return;
    }

    this.dispatchRoborockMatterCommand(
      "empty dust bin",
      () =>
        startDustCollection.call(
          this.api,
          this.getDuid(),
          this.getMatterCommandOptions()
        ),
      { surface }
    );
  }

  private scheduleMatterStateUpdate(
    reason: string,
    optimisticGeneration: number
  ): void {
    if (!this.registered) {
      return;
    }

    const timer = scheduleTimer(() => {
      if (optimisticGeneration !== this.optimisticGeneration) {
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

  /**
   * Write the RvcOperationalState cluster against what the store holds.
   *
   * WHAT matter.js 0.17.9 DOES WITH THIS CLUSTER (the build Homebridge 2.4.0
   * ships; RvcOperationalStateServer, replayed in
   * test-support/matter-0.17.9-store.js):
   *
   * - writing any `operationalError` other than NoError FORCES
   *   `operationalState` to Error (3) and emits the OperationalError event —
   *   the event Apple Home turns into a push notification;
   * - writing an `operationalState` other than Error while the store is in
   *   Error with a fault standing CLEARS the fault; clearing the fault alone
   *   does not give the old state back.
   *
   * Measured on 17 Sep 2026 against 0.17.9 with a standing 68: a write of the
   * same state (0x42) and of a different one (0x41) both wiped it; phase and
   * list writes did not. The 60-second heartbeat re-wrote the state, so the
   * fault was cleared and raised once a minute — the 2-minute "refill the
   * water tank" in #9, #5 and #26.
   *
   * THE RULES, all decided from the store as it is read back, never from what
   * this class believes it wrote:
   *
   * 1. A fault being raised is written ALONE. matter.js puts the state at
   *    Error anyway, and a state written first would only be a second change.
   * 2. While a fault stands and the snapshot names the same fault, or names
   *    none (nothing is known — the 3.12.1 rule that an unknown robot clears
   *    nobody's warning), `operationalState` is not written at all.
   * 3. NoError is a state write: the robot's real state replaces Error, which
   *    clears the fault, and the tile gets that state straight back.
   * 4. Everything else in the cluster is written where it differs; none of it
   *    touches the fault.
   *
   * Because the store is read back, a write matter.js refused is simply
   * written again on the next publish — and none of the rules depends on a
   * write having landed, so a store read a moment early can at worst repeat a
   * write, never wipe a fault and raise it again.
   */
  private async writeOperationalStateCluster(
    matter: MatterStoreApi,
    attributes: Record<string, unknown>,
    stored: Record<string, unknown> | undefined
  ): Promise<void> {
    const { operationalState, operationalError, ...rest } = attributes;
    const wantedError = (
      operationalError as { errorStateId?: unknown } | undefined
    )?.errorStateId;
    const storedError = (
      stored?.operationalError as { errorStateId?: unknown } | undefined
    )?.errorStateId;
    const faultStands =
      typeof storedError === "number" &&
      storedError !== RVC_OPERATIONAL_ERROR.NO_ERROR;
    const raisingFault =
      typeof wantedError === "number" &&
      wantedError !== RVC_OPERATIONAL_ERROR.NO_ERROR;

    const writeState =
      operationalState !== undefined &&
      !raisingFault &&
      !(wantedError === undefined && faultStands) &&
      (stored === undefined ||
        !isSameMatterValue(operationalState, stored.operationalState));

    const first = attributesTheStoreLacks(rest, stored);
    if (writeState) {
      first.operationalState = operationalState;
    }
    if (Object.keys(first).length > 0) {
      await matter.updateAccessoryState(
        this.accessory.UUID,
        OPERATIONAL_STATE_CLUSTER,
        first
      );
    }

    if (typeof wantedError !== "number") {
      return;
    }
    // A state written over a standing fault has just cleared it (rule 3).
    const errorAfterStateWrite =
      writeState && faultStands ? RVC_OPERATIONAL_ERROR.NO_ERROR : storedError;
    if (stored !== undefined && wantedError === errorAfterStateWrite) {
      return;
    }
    await matter.updateAccessoryState(
      this.accessory.UUID,
      OPERATIONAL_STATE_CLUSTER,
      { operationalError }
    );
  }

  /**
   * The cluster as the Matter store holds it; null when the store answered
   * that it holds no such cluster; undefined if it cannot say.
   */
  private async readMatterStore(
    matter: MatterStoreApi,
    cluster: string
  ): Promise<Record<string, unknown> | null | undefined> {
    if (typeof matter.getAccessoryState !== "function") {
      return undefined;
    }
    try {
      const stored = await matter.getAccessoryState(
        this.accessory.UUID,
        cluster
      );
      return stored && typeof stored === "object" ? stored : null;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the registered endpoint lacks `cluster`, which the store just
   * read back as absent.
   *
   * Homebridge builds the endpoint once, from accessory.clusters at
   * registration, and refuses a write to any other cluster with two ERROR
   * lines — on every publish, since nothing it does can add the cluster to a
   * running accessory (2.4.0 has no way to: updatePlatformAccessories keeps
   * the endpoint, and re-registering an external accessory deletes its
   * pairing). The RVC's own two clusters are on every endpoint, so absent
   * means the store cannot see this robot at all — written as before — and
   * an optional cluster counts as missing only while they read back.
   */
  private async isClusterMissingFromEndpoint(
    matter: MatterStoreApi,
    cluster: string
  ): Promise<boolean> {
    if (cluster === OPERATIONAL_STATE_CLUSTER || cluster === "rvcRunMode") {
      return false;
    }
    const mandatory = await this.readMatterStore(
      matter,
      OPERATIONAL_STATE_CLUSTER
    );
    if (!mandatory) {
      return false;
    }
    if (!this.reportedClustersMissingFromEndpoint.has(cluster)) {
      this.reportedClustersMissingFromEndpoint.add(cluster);
      const what =
        cluster === "serviceArea"
          ? "its rooms"
          : cluster === "rvcCleanMode"
            ? "its cleaning modes"
            : `its ${cluster}`;
      this.platform.log.info(
        `${this.getVacuumName()} has ${what} to show in Apple Home now, but its Matter accessory was created before they were known, and Homebridge cannot add them to an accessory that is already running. Restart Homebridge (or this plugin's child bridge) once to show them.`
      );
    }
    return true;
  }

  private async updateMatterState(
    partialClusters: Record<string, Record<string, unknown>>,
    reason = "state update"
  ): Promise<boolean> {
    if (!this.registered) {
      return false;
    }

    const matter = this.platform.getMatterApi() as MatterStoreApi | null;
    if (!matter || typeof matter.updateAccessoryState !== "function") {
      return false;
    }

    if (Object.keys(partialClusters).length === 0) {
      return false;
    }

    // WRITTEN AGAINST THE STORE, NOT AGAINST A MEMORY OF WHAT WAS WRITTEN.
    //
    // Homebridge 2.x's `updateAccessoryState` validates, emits and returns;
    // the store write runs later in a setImmediate, and a write matter.js
    // refuses is only logged by Homebridge ("Failed to update state for
    // accessory …", StateManager.js). This class used to record each write as
    // published the moment the call returned and skip anything identical, so
    // a refused write was believed for a minute (the heartbeat) or ten (the
    // operational state). Reading the cluster back with
    // `api.matter.getAccessoryState` (present since Homebridge 2.0.0) and
    // writing only what differs makes a refused write come back on the very
    // next publish, and needs no record at all.
    //
    // Publishes are serialized, and each one that reads the store back ends
    // after Homebridge has applied its writes (afterDeferredMatterWrites), so
    // the next one reads them back rather than the store as it was before.
    // Without that, the once-per-boot battery nudge (null, then the value)
    // read the value back from before the null landed and skipped it.
    //
    // What can fail here: the synchronous assertMatterReady refusal
    // (Homebridge not launched / Matter not enabled). Each cluster is written
    // on its own, so one that throws can never block the others — a frozen
    // battery reading because the operational state failed is the failure
    // this isolation exists for.
    const clusterEntries = Object.entries(partialClusters);
    const readsBack = typeof matter.getAccessoryState === "function";
    const publishTask = this.matterPublishChain.then(async () => {
      const failures: unknown[] = [];
      for (const [cluster, attributes] of clusterEntries) {
        try {
          const read = await this.readMatterStore(matter, cluster);
          if (
            read === null &&
            (await this.isClusterMissingFromEndpoint(matter, cluster))
          ) {
            continue;
          }
          const stored = read ?? undefined;
          if (cluster === OPERATIONAL_STATE_CLUSTER) {
            await this.writeOperationalStateCluster(matter, attributes, stored);
            continue;
          }
          const changed = attributesTheStoreLacks(attributes, stored);
          if (Object.keys(changed).length > 0) {
            await matter.updateAccessoryState(
              this.accessory.UUID,
              cluster,
              changed
            );
          }
        } catch (error) {
          failures.push(error);
          this.platform.log.debug(
            `Matter publish (${reason}) of cluster ${cluster} for ${this.getVacuumName()} failed: ${this.getErrorMessage(error)}`
          );
        }
      }
      if (readsBack) {
        await afterDeferredMatterWrites();
      }
      if (failures.length === clusterEntries.length) {
        throw failures[0];
      }
    });
    this.matterPublishChain = publishTask.then(
      () => undefined,
      () => undefined
    );

    await publishTask;
    return true;
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
    reason: string
  ): Promise<boolean> {
    // This is the one place every Roborock-driven state change passes
    // through, so it is the only hook that cannot miss one — including a poll
    // whose clusters the store already holds, which is how a listener's first
    // reading after a restart usually arrives.
    this.rememberPublishedRunMode(clusters);
    this.notifyStateListener();

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
      this.logMatterPublishIfChanged(clusters, reason);
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
    const cleanArea = this.getNumberFromValue(status.clean_area);
    const cleanTime = this.getNumberFromValue(status.clean_time);

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
    if (
      MEANINGFUL_LIVE_STATUS_FIELDS.every(
        (field) => this.getNumberFromValue(status[field]) === null
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

    this.rememberStatusFrame(status);

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
      const robotState = this.getRoborockOperationalState(
        state,
        this.getNumberStatus("charge_status")
      );
      if (
        robotState === RVC_OPERATIONAL_STATE.RUNNING ||
        robotState === RVC_OPERATIONAL_STATE.PAUSED
      ) {
        // The start has been acted on; its rooms now belong to a real run.
        this.serviceAreaProgressBeforeStart = null;
      }
      this.completeServiceAreaProgressIfDone(robotState);
      this.beginFullCleanServiceAreaProgressIfUnannounced(state, chargeStatus);
    }

    // Live map-position room tracking: reflect the physically detected room
    // in currentArea/progress before the snapshot below is built.
    const liveOperationalState = this.getOperationalState();
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

    if (this.isCleanModeEnabled()) {
      clusters.rvcCleanMode = this.buildCleanModeCluster();
    }
    if (this.isPowerSourceEnabled()) {
      clusters.powerSource = this.buildPowerSourceCluster();
    }

    if (this.isServiceAreaEnabled() && this.hasServiceAreasToExpose()) {
      // Publishing a Service Area cluster with an empty supportedAreas list
      // violates Matter conformance (the spec requires at least one area)
      // and makes Apple Home abort commissioning. Robots without room data
      // (e.g. B01/Q7 until the map channel lands) omit the cluster instead.
      clusters.serviceArea = this.buildServiceAreaCluster();
    }

    return this.withFaultOnlyWhereItCanStand(
      this.applyOptimisticState(clusters)
    );
  }

  /**
   * The last word on the fault, taken AFTER the optimistic overlay.
   *
   * buildOperationalStateCluster() decides from what the robot reports. A
   * Matter command then lays an optimistic Running over that for a few
   * seconds, and a fault built for the docked robot underneath would go out
   * beside it — which matter.js turns into Error and an OperationalError
   * event, the #35 symptom by a second door (found in review: Start pressed,
   * dock reports the tank dry before the robot reports Cleaning). So a fault
   * the PUBLISHED state cannot carry is dropped from the payload: no new
   * fault is raised, and one already standing is left for the next real
   * reading to settle.
   */
  private withFaultOnlyWhereItCanStand(
    clusters: MatterClusterState
  ): MatterClusterState {
    const cluster = clusters.rvcOperationalState as
      | Record<string, unknown>
      | undefined;
    const published = cluster?.operationalState;
    const errorStateId = (
      cluster?.operationalError as { errorStateId?: unknown } | undefined
    )?.errorStateId;
    if (
      !cluster ||
      typeof published !== "number" ||
      OPERATIONAL_STATES_THAT_CARRY_A_FAULT.has(published) ||
      typeof errorStateId !== "number" ||
      errorStateId === RVC_OPERATIONAL_ERROR.NO_ERROR
    ) {
      return clusters;
    }

    const { operationalError: _withheld, ...rest } = cluster;
    return { ...clusters, rvcOperationalState: rest };
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
          ? ALL_FAN_POWER_CLEAN_MODES
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
    return (
      ALL_FAN_POWER_CLEAN_MODES.find(
        (powerMode) => powerMode.mode === cleanMode
      ) ?? null
    );
  }

  private doesLiveCleanModeMatch(cleanMode: number): boolean {
    const expectedBaseType = this.getBaseCleanType(cleanMode);
    const liveType = this.getLiveCleanType();
    if (liveType !== null && !this.acceptLiveCleanType(liveType)) {
      return false;
    }
    if (
      liveType !== null &&
      this.getBaseCleanType(liveType) !== expectedBaseType
    ) {
      return false;
    }

    const fanPowerMode = this.getFanPowerCleanMode(cleanMode);
    if (fanPowerMode) {
      // Some robots omit a live clean type, but fan power independently
      // confirms a suction variant. Base clean-type changes have no equivalent
      // independent signal and still require the robot to report a live type.
      return this.getNumberStatus("fan_power") === fanPowerMode.fanPower;
    }

    return liveType !== null;
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
    const operationalState = this.getOperationalState();
    const inCleaningRun = this.isInCleaningRunMode(operationalState);

    if (this.selectedCleanModeLiveConfirmationExpiresAt > 0) {
      if (!inCleaningRun) {
        this.selectedCleanModeLiveConfirmationExpiresAt = 0;
      } else if (this.doesLiveCleanModeMatch(this.selectedCleanMode)) {
        this.selectedCleanModeLiveConfirmationExpiresAt = 0;
        this.appliedCleanTypePin = null;
        this.clearOptimisticCluster("rvcCleanMode");
      } else if (Date.now() < this.selectedCleanModeLiveConfirmationExpiresAt) {
        return selected;
      } else {
        this.selectedCleanModeLiveConfirmationExpiresAt = 0;
        this.appliedCleanTypePin = null;
        this.platform.log.warn(
          `Roborock acknowledged the live ${this.getCleanModeLabel(this.selectedCleanMode)} change for ${this.getVacuumName()}, but its status did not converge within ${MATTER_CLEAN_MODE_LIVE_CONFIRMATION_TIMEOUT_MS / 1000} seconds; Apple Home will now follow the robot's live report.`
        );
      }
    }

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
        const liveMode = ALL_FAN_POWER_CLEAN_MODES.find(
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

    const waterBoxMode = this.getWaterBoxModeStatus();
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
    // Guard against older/patched API builds lacking the method or returning
    // undefined so cluster builds (which run inside Matter attribute reads)
    // can never throw.
    return (
      this.api.getMatterCleanModeCapabilities?.(this.getDuid()) ?? {
        canVacuum: true,
        canMop: false,
      }
    );
  }

  /**
   * Apply a clean mode picked while the robot is already running or paused,
   * and pin its clean type for the rest of this run. Throws when the robot
   * does not confirm the settings, so the ChangeToMode handler rolls the
   * selection back instead of showing a mode the robot is not in.
   */
  private async applyCleanModeDuringRun(cleanMode: number): Promise<void> {
    const applySettings = this.api.applyMatterCleanModeSettings;
    if (typeof applySettings !== "function") {
      throw new Error("Roborock clean-mode control is unavailable.");
    }

    const settings = this.getRoborockCleanModeSettings(cleanMode);
    if (!settings) {
      throw new Error(
        `No Roborock settings exist for ${this.getCleanModeLabel(cleanMode)}.`
      );
    }

    this.platform.log.info(
      `Applying ${this.getCleanModeLabel(cleanMode)} mode to ${this.getVacuumName()} during cleaning.`
    );

    const result = await this.withCleanModePrepTimeout(
      applySettings.call(
        this.api,
        this.getDuid(),
        settings,
        this.getMatterCleanModeLiveCommandOptions()
      )
    );

    if (result?.unconfirmedSettings?.length) {
      throw new Error(
        `Roborock did not confirm the ${result.unconfirmedSettings.join(
          " and "
        )} during the live clean-mode change.`
      );
    }

    this.selectedCleanModeNeedsApply = false;
    this.selectedCleanModeLiveConfirmationExpiresAt =
      Date.now() + MATTER_CLEAN_MODE_LIVE_CONFIRMATION_TIMEOUT_MS;
    this.appliedCleanTypePin = {
      cleanType: this.getBaseCleanType(cleanMode),
      runObserved: true,
      reported: false,
    };
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

  /**
   * The water level, from the robot's own `get_status` (`water_box_mode`, also
   * pushed alone as dps 124) — the field python-roborock reads. A product
   * schema's `water_box_custom_mode` exists only in the HomeData snapshot, so
   * it answers only when the robot has never said.
   */
  private getWaterBoxModeStatus(): number | null {
    return (
      this.getNumberStatus("water_box_mode") ??
      this.getNumberStatus("water_box_custom_mode")
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

  /**
   * Whether a fault may stand: the robot is not in a cleaning run, or it has
   * really halted.
   *
   * In matter.js 0.17.9 any fault IS the Error state (see
   * OPERATIONAL_STATES_THAT_CARRY_A_FAULT), so a robot that is cleaning,
   * paused or on its way home from a run is published without one: Error
   * would hide the clean (#35). A robot idle in its dock is not in a run while
   * the dock empties the bin, washes, dries or swaps the mop, or reports the
   * "returning" blip after emptying. Withdrawing a standing tank fault there
   * and raising it again afterwards was one more notification per chore for a
   * tank nobody had touched (#26). Run membership is the run mode those states
   * inherit (resolveRunMode) — the answer Apple Home is given, read here
   * without advancing it.
   */
  private canCarryAFault(): boolean {
    const robotState = this.getRoborockOperationalState(
      this.getNumberStatus("state"),
      this.getNumberStatus("charge_status")
    );
    if (robotState === RVC_OPERATIONAL_STATE.ERROR) {
      return true;
    }
    const inRun = RUN_MODE_INHERITED_STATES.has(robotState)
      ? this.lastRunMode === RUN_MODE_CLEANING
      : this.isInCleaningRunMode(robotState);
    return !inRun;
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
      if (!this.canCarryAFault()) {
        // A robot in a run — cleaning, paused, driving home, or busy at the
        // dock in the middle of one — is not blocked, so it gets NoError,
        // whatever the tank or the robot's own error field says. In matter.js
        // 0.17.9 a fault IS the Error state, and Error is what hid a running
        // clean in issue #35. Writing NoError here is affirmative, not
        // invented: the run itself says the robot works.
        cluster.operationalError = {
          errorStateId: RVC_OPERATIONAL_ERROR.NO_ERROR,
        };
      } else if (fault !== null) {
        // Null means neither the dock nor the robot has said. Publishing
        // NoError on their behalf would clear a warning nobody has
        // contradicted, so an unknown robot leaves the attribute where it was.
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
    // This comment used to say the operational state is deliberately NOT
    // forced to Error along with the fault. That was never true on the
    // matter.js people run: 0.17.9 forces it itself the moment a fault is
    // written (issue #35 decoded it off the wire). What IS still true is the
    // cost it named — a robot in Error is refused a Start — which is why a
    // tank warning is only published for a robot at rest and only when the
    // chosen mode needs water (getMatterFault, isVacuumOnlyModeChosen).
    //
    // The Error operational STATE is a different matter and is still
    // reported below: Apple renders operational states perfectly well (the
    // same robot shows Charging, Docked, Emptying and Washing correctly), so
    // a robot stuck under the sofa can stop claiming it is Ready without
    // touching the attribute that causes trouble.

    return cluster;
  }

  private buildPowerSourceCluster(): Record<string, unknown> {
    const battery = this.getNumberStatus("battery");
    const chargeStatus = this.getNumberStatus("charge_status");
    const state = this.getNumberStatus("state");
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

  private hasServiceAreasToExpose(): boolean {
    return this.getMatterServiceAreas().length > 0;
  }

  private persistServiceAreaProgress(): void {
    // Kept across a restart (the platform saves the Matter accessories'
    // context at shutdown), so a restart mid-clean restores the room display
    // instead of silently dropping back to a generic label.
    this.accessory.context.serviceAreaProgressState = {
      currentArea: this.serviceAreaCurrentArea,
      progress: this.serviceAreaProgress.map((entry) => ({ ...entry })),
    };
  }

  private restoreServiceAreaProgress(): void {
    // The selection too: without it Apple Home snapped back to "no rooms"
    // after every restart, and Start cleaned the whole house.
    const selection = this.accessory.context?.selectedServiceAreaIds;
    if (Array.isArray(selection)) {
      this.selectedServiceAreaIds = selection.filter(
        (areaId): areaId is number =>
          typeof areaId === "number" && Number.isInteger(areaId)
      );
    }
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
    // We know which rooms were requested, not which one the robot is in.
    // Naming the first one as current and Operating said so for the whole run
    // on a robot without live rooms (#24: "the progress indicator on Kitchen"
    // while the S8 cleaned elsewhere). So, as for a full clean: every
    // requested room Operating, none current, until live map-position
    // tracking resolves one (see beginFullCleanServiceAreaProgress).
    this.resetLiveRoomVisits();
    this.serviceAreaStopRequested = false;
    this.serviceAreaCurrentArea = null;
    this.serviceAreaProgress = areaIds.map((areaId) => ({
      areaId,
      status: SERVICE_AREA_PROGRESS.OPERATING,
    }));
    this.persistServiceAreaProgress();
  }

  /**
   * A full-home clean operates on every supported area, and we cannot know
   * which room the robot is physically inside — the robots do not report it.
   * So `currentArea` stays null: no room is named that we are not sure of.
   *
   * The scope is published as OPERATING rather than PENDING, and that choice
   * is the whole point of this function, so it is worth writing down why.
   *
   * Matter has 4 progress values and none of them means "in this run, exact
   * position unknown". Both available encodings are therefore imperfect:
   * every area operating asserts the robot is in all of them, every area
   * pending asserts it is in none of them. The second is the one that reads
   * as a bug, because Apple Home renders "nothing is operating" as *the robot
   * is still on its way* — "Traveling to Room", "heading to the room",
   * "Desplazándose" — and keeps saying it for the entire run while the robot
   * is demonstrably cleaning.
   *
   * 2.3.1 already tried the honest-looking option. It moved a full clean from
   * an empty list to an all-pending list hoping Apple's label would improve,
   * and said out loud that whether it did was up to Apple's renderer. It did
   * not: skmzwanke reported the stuck label in #8, and vp-debug12 reported
   * exactly the same thing in #9 months and many versions later, in Spanish.
   * 2 independent users, one unchanged symptom, one failed mitigation.
   *
   * So this picks the encoding that produces the true statement at the only
   * place a person looks. The robot IS operating; it is not on its way. Live
   * map-position tracking still collapses this to the accurate single-room
   * picture the moment it resolves a room, and the run still flips wholly to
   * completed when the robot returns to the charger.
   */
  private beginFullCleanServiceAreaProgress(): void {
    const areaIds = this.getMatterServiceAreas().map((area) => area.areaId);
    if (areaIds.length === 0) {
      this.clearServiceAreaProgress();
      return;
    }
    this.resetLiveRoomVisits();
    this.serviceAreaStopRequested = false;
    this.serviceAreaCurrentArea = null;
    this.serviceAreaProgress = areaIds.map((areaId) => ({
      areaId,
      status: SERVICE_AREA_PROGRESS.OPERATING,
    }));
    this.persistServiceAreaProgress();
  }

  /**
   * Announce a run that arrived as a status change rather than as a command.
   *
   * 3.15.1 fixed the encoding of a whole-home clean's progress list, but it
   * only ever ran from the Matter/HAP start handler — so it only fixed runs
   * started in Apple Home, and most runs are not. A clean started in the
   * Roborock app, by a schedule stored in the app, by the button on the lid or
   * by a voice assistant reaches this plugin as a state change and nothing
   * else. The progress list then stayed empty, or stale all-completed from the
   * last Apple Home run, for the whole run — which is precisely the "Traveling
   * to Room" / "Desplazándose" symptom #8 and #9 reported, still unfixed for
   * the way they most likely start their robots.
   *
   * The asymmetry was the tell: completion has always been status-driven
   * (`completeServiceAreaProgressIfDone`), and only the start was not.
   */
  private beginFullCleanServiceAreaProgressIfUnannounced(
    state: number | null,
    chargeStatus: number | null
  ): void {
    // The UNGATED state on purpose. With extended operational states off, the
    // dock chores are rewritten to RUNNING, and a dock washing the mop must
    // not announce that the robot is cleaning every room in the house. The
    // rule is deliberately "whatever we already publish as a running robot",
    // one list rather than a second one that can drift out of step with it.
    if (
      this.getRoborockOperationalState(state, chargeStatus) !==
      RVC_OPERATIONAL_STATE.RUNNING
    ) {
      return;
    }

    // Anything still operating or pending is a run somebody already announced
    // — either one started here, whose narrower and better-known scope must
    // not be widened, or one this function announced on an earlier poll. Only
    // an empty list, or a stale all-completed one from the previous run, means
    // no controller has been told that the robot is working.
    if (
      this.serviceAreaProgress.some(
        (entry) =>
          entry.status === SERVICE_AREA_PROGRESS.OPERATING ||
          entry.status === SERVICE_AREA_PROGRESS.PENDING
      )
    ) {
      return;
    }

    this.serviceAreaProgressBeforeStart = null;
    this.beginFullCleanServiceAreaProgress();
  }

  /** Every run boundary starts live-room confirmation from nothing. */
  private resetLiveRoomVisits(): void {
    this.liveConfirmedServiceAreaIds = new Set();
    this.liveRoomVisit = null;
  }

  private clearServiceAreaProgress(): void {
    this.resetLiveRoomVisits();
    this.serviceAreaCurrentArea = null;
    this.serviceAreaProgress = [];
    this.persistServiceAreaProgress();
  }

  /**
   * Settle the room list once the robot is out of a run — but only the run
   * that actually happened.
   *
   * - A robot that halted (Error) has not finished: the list stays as it is
   *   for the run to resume or end.
   * - A Matter start the robot was never seen acting on — refused, or
   *   acknowledged and ignored — gives the list back as it was before the
   *   start, once the plugin itself has stopped showing the start
   *   (isMatterStartStillPending). Those rooms were not cleaned.
   * - A run Matter stopped ends with the rooms the robot was not seen
   *   cleaning Skipped (Matter's own value for it); any other end of a run
   *   completes every room, as before.
   *
   * `robotState` is the robot's own operational state, not the one the
   * extended-states toggle displays: driving home is still part of the run.
   */
  private completeServiceAreaProgressIfDone(robotState: number): void {
    if (this.serviceAreaProgress.length === 0) {
      return;
    }
    if (
      this.isInCleaningRunMode(robotState) ||
      robotState === RVC_OPERATIONAL_STATE.ERROR
    ) {
      return;
    }
    if (this.serviceAreaProgressBeforeStart) {
      if (!this.isMatterStartStillPending()) {
        this.restoreServiceAreaProgressFromBeforeStart();
      }
      return;
    }
    const unfinished = this.serviceAreaStopRequested
      ? SERVICE_AREA_PROGRESS.SKIPPED
      : SERVICE_AREA_PROGRESS.COMPLETED;
    // A room already settled keeps its answer: Skipped was not cleaned. So
    // settling a settled list again — the next poll after a stop, or the
    // first status after a restart — changes nothing.
    this.serviceAreaProgress = this.serviceAreaProgress.map((entry) => ({
      areaId: entry.areaId,
      status:
        entry.status === SERVICE_AREA_PROGRESS.COMPLETED ||
        entry.status === SERVICE_AREA_PROGRESS.SKIPPED
          ? entry.status
          : this.liveConfirmedServiceAreaIds.has(entry.areaId)
            ? SERVICE_AREA_PROGRESS.COMPLETED
            : unfinished,
    }));
    this.resetLiveRoomVisits();
    this.serviceAreaCurrentArea = null;
    this.serviceAreaStopRequested = false;
    this.persistServiceAreaProgress();
  }

  private rememberServiceAreaProgressBeforeStart(): void {
    // A second start before the first was acted on keeps the original list.
    this.serviceAreaProgressBeforeStart ??= {
      currentArea: this.serviceAreaCurrentArea,
      progress: this.serviceAreaProgress.map((entry) => ({ ...entry })),
    };
  }

  /** A failed or ignored start gives back the list it replaced. */
  private restoreServiceAreaProgressFromBeforeStart(): void {
    const before = this.serviceAreaProgressBeforeStart;
    if (!before) {
      return;
    }
    this.serviceAreaProgressBeforeStart = null;
    this.serviceAreaStopRequested = false;
    this.resetLiveRoomVisits();
    this.serviceAreaCurrentArea = before.currentArea;
    this.serviceAreaProgress = before.progress;
    this.persistServiceAreaProgress();
  }

  /**
   * Whether the plugin is still showing a start the robot has not acted on:
   * the optimistic Running is up, or the start is inside the window in which
   * a slow robot (cloud-only S8, #4) still reports docked.
   */
  private isMatterStartStillPending(): boolean {
    return (
      this.hasRecentlyCommandedCleaning() ||
      this.getActiveOptimisticState()?.rvcOperationalState?.operationalState ===
        RVC_OPERATIONAL_STATE.RUNNING
    );
  }

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

  /**
   * Fold one live-room observation into the current visit, and promote the
   * room to confirmed once the visit is long enough to be a clean rather than
   * a crossing. See `liveRoomVisit` for why both conditions are needed.
   */
  private recordLiveRoomVisit(areaId: number, observedAt: number): void {
    let visit = this.liveRoomVisit;
    if (!visit || visit.areaId !== areaId) {
      // A different room ends the previous visit outright: dwell is never
      // accumulated across separate passes through the same room.
      visit = {
        areaId,
        readings: 1,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      };
      this.liveRoomVisit = visit;
    } else if (observedAt > visit.lastSeenAt) {
      // A genuinely new sighting. Re-reading the cached sample — which happens
      // whenever a publish cycle runs faster than the live-room refetch — adds
      // neither a reading nor dwell, because nothing new was observed.
      visit.readings += 1;
      visit.lastSeenAt = observedAt;
    }

    if (
      visit.readings >= LIVE_ROOM_READINGS_TO_CONFIRM &&
      visit.lastSeenAt - visit.firstSeenAt >= LIVE_ROOM_DWELL_TO_CONFIRM_MS
    ) {
      this.liveConfirmedServiceAreaIds.add(areaId);
    }
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
    // The reading's own observation time. Older API surfaces on the classic
    // path may not carry one; processing time is the honest fallback there.
    const observedAt = this.getNumberFromValue(liveRoom?.at) ?? Date.now();

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

    this.recordLiveRoomVisit(area.areaId, observedAt);
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
    // Filtered for matter.js, which refuses a selection naming a room that is
    // not in supportedAreas — but not stored back: the list is momentarily
    // partial while a map refreshes, and trimming the selection here dropped
    // those rooms from it for good.
    const selectedAreas = this.selectedServiceAreaIds.filter((areaId) =>
      supportedAreaIds.has(areaId)
    );

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
      //
      // Filtered against the areas being published, because matter.js
      // 0.17.9 refuses the WHOLE serviceArea write when one progress entry
      // or the current area names a room that is not in supportedAreas —
      // and Homebridge only logs the refusal. Progress is persisted across
      // restarts, so a room merged away in the Roborock app since the last
      // run froze the cluster (rooms, selection and live room) until the
      // next run started.
      progress: this.serviceAreaProgress
        .filter(
          (entry, index, all) =>
            supportedAreaIds.has(entry.areaId) &&
            all.findIndex((other) => other.areaId === entry.areaId) === index
        )
        .map((entry) => ({ ...entry })),
      estimatedEndTime: null,
      supportedAreas: this.withUniqueLocationNames(
        areas,
        includeMapNamesInAreaLabels
      ).map(({ area, locationName }) => ({
        areaId: area.areaId,
        mapId: area.mapId,
        areaInfo: {
          locationInfo: {
            locationName,
            floorNumber: null,
            areaType: null,
          },
          landmarkInfo: null,
        },
      })),
      selectedAreas,
      currentArea: (() => {
        const currentArea =
          this.serviceAreaCurrentArea ??
          this.getCurrentServiceArea(selectedAreas);
        return currentArea !== null && supportedAreaIds.has(currentArea)
          ? currentArea
          : null;
      })(),
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

  /**
   * Homebridge 2.4.0's `selectAreas` (dist/matter/behaviors/
   * ServiceAreaBehavior.js) runs this handler and then ALWAYS runs matter.js's
   * own `ServiceAreaServer.selectAreas`, whose answer is what the controller
   * receives. Whatever this handler returns is thrown away. Until 3.39.0 it
   * returned an InvalidSet status that never reached anybody: matter.js
   * stored the refused selection, this plugin kept its old one, and the next
   * heartbeat put the old one back. The only way to refuse is to throw, which
   * stops matter.js from storing anything — so the plugin's selection and the
   * controller's can no longer drift apart.
   */
  private async selectServiceAreas(newAreas?: unknown): Promise<void> {
    const supportedAreas = new Map(
      this.getMatterServiceAreas().map((area) => [area.areaId, area])
    );
    const {
      areaIds: selectedAreas,
      unreadable,
      repeated,
    } = this.readMatterAreaIds(newAreas);
    const unsupportedArea = selectedAreas.find(
      (areaId) => !supportedAreas.has(areaId)
    );

    // WHAT ARRIVED, NOT ONLY WHAT WAS UNDERSTOOD — #24. "none" used to stand
    // for an empty list, a list nothing could be read from and no list at all.
    const requestedCount = Array.isArray(newAreas) ? newAreas.length : null;
    const notes = [
      unreadable > 0
        ? `${unreadable} of which could not be read as an area id`
        : "",
      repeated > 0 ? `${repeated} repeated` : "",
    ].filter(Boolean);
    const requestDetail =
      requestedCount === null
        ? " (the controller sent no area list)"
        : requestedCount === 0
          ? " (the controller sent an empty list, which Matter defines as no area restriction)"
          : notes.length > 0
            ? ` (the controller sent ${requestedCount} entr${requestedCount === 1 ? "y" : "ies"}, ${notes.join(", ")})`
            : "";

    this.platform.log.info(
      `Matter service area selection request for ${this.getVacuumName()}: ${selectedAreas.join(", ") || "none"}${requestDetail}.`
    );

    if (unsupportedArea !== undefined) {
      // Thrown rather than left to matter.js's own UnsupportedArea check,
      // which tests its last published room list: when that differs from the
      // plugin's, matter.js would store a selection the plugin refused.
      this.platform.log.warn(
        `Matter service area ${unsupportedArea} is not on the Roborock room map of ${this.getVacuumName()}, so the selection is refused and the controller keeps its previous one. Homebridge logs the refusal as a handler error right after this line; that is expected.`
      );
      throw this.createMatterStatusError(
        "ConstraintError",
        `Area ${unsupportedArea} is not available from the Roborock room map.`
      );
    }

    const selectedMapIds = this.getSelectedServiceAreaMapIds(
      selectedAreas
        .map((areaId) => supportedAreas.get(areaId))
        .filter((area): area is MatterServiceArea => area !== undefined)
    );
    if (selectedMapIds.length > 1) {
      this.platform.log.warn(
        `Ignoring Matter service area selection spanning ${selectedMapIds.length} Roborock maps for ${this.getVacuumName()} (maps ${selectedMapIds.join(", ")}; areas ${selectedAreas.join(", ")}); select areas from one map at a time. The selection is refused, not cleared, so the controller will keep showing the previous selection. Homebridge logs the refusal as a handler error right after this line; that is expected.`
      );
      throw this.createMatterStatusError(
        "ConstraintError",
        "Select service areas from only one Roborock map at a time."
      );
    }

    this.selectedServiceAreaIds = selectedAreas;
    this.accessory.context.selectedServiceAreaIds = [...selectedAreas];
    // A SELECTION MADE BETWEEN RUNS HAS NO PROGRESS YET — #24.
    //
    // Progress is persisted, so the finished rooms of the morning's run were
    // still published when Marrand picked all eight rooms in the afternoon.
    // Apple Home sends an empty list for "all rooms" (Matter: no restriction),
    // and with nothing selected it showed the two rooms in that stale
    // progress, every time. A run in progress keeps its own progress; the
    // new selection applies to the next run.
    if (!this.isInCleaningRunMode(this.getOperationalState())) {
      this.clearServiceAreaProgress();
    }
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
        `Cleared Matter service area selection for ${this.getVacuumName()}; Start cleans every room.`
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
  }

  /**
   * An error Homebridge passes to the controller as a Matter status, through
   * `api.matter.status` (Homebridge's own advice: not a value import of
   * `MatterStatus`). A plain Error is wrapped as Failure, which still stops
   * matter.js from storing anything.
   */
  private createMatterStatusError(
    status: "ConstraintError",
    message: string
  ): Error {
    const StatusError = this.platform.getMatterApi()?.status?.[status];
    return typeof StatusError === "function"
      ? new StatusError(message)
      : new Error(message);
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

    // A room filed under no map (roborockLib keeps a `-1` bucket for a status
    // that had no `map_status`) cannot sit beside rooms on a real map:
    // matter.js refuses the whole serviceArea write ("Areas must not have a
    // null mapId when supportedMaps is defined"), every time. It cannot be
    // cleaned from a map selection either, so it is left out while real maps
    // exist.
    if (!areas.some((area) => area.mapId !== null)) {
      return areas;
    }
    const withoutMap = areas.filter((area) => area.mapId === null);
    this.reportRoomsWithoutAMap(withoutMap);
    return withoutMap.length > 0
      ? areas.filter((area) => area.mapId !== null)
      : areas;
  }

  /** Say once per distinct set which rooms were left out, and why. */
  private reportRoomsWithoutAMap(rooms: MatterServiceArea[]): void {
    const names = rooms.map((room) => room.name).join(", ");
    if (names === this.lastReportedRoomsWithoutAMap) {
      return;
    }
    this.lastReportedRoomsWithoutAMap = names;
    if (names) {
      this.platform.log.info(
        `${this.getVacuumName()}: room(s) ${names} belong to no Roborock map while other rooms do, so they are not offered in Apple Home (Matter refuses a room list that mixes the two). They come back once the robot reports them on a map.`
      );
    }
  }

  private getMatterServiceAreaMaps(
    areas: MatterServiceArea[]
  ): MatterServiceAreaMap[] {
    // Matter controllers can hang if supportedMaps advertises maps with no
    // matching supportedAreas, or if supportedAreas reference a mapId that has
    // no supportedMaps entry. Build supportedMaps from exactly the maps that
    // have areas, named by the Roborock map name each area already carries
    // (see getMatterServiceAreas) or a generated label.
    const maps: MatterServiceAreaMap[] = [];
    const seenMapIds = new Set<number>();
    // matter.js 0.17.9 refuses two maps with the same name exactly as it
    // refuses two rooms with the same name (ServiceAreaServer
    // #assertSupportedMaps), so the second "Home" is "Home 2".
    const usedNames = new Set<string>();

    for (const area of areas) {
      if (area.mapId === null || seenMapIds.has(area.mapId)) {
        continue;
      }

      seenMapIds.add(area.mapId);
      const base = area.mapName || `Roborock Map ${area.mapId}`;
      let name = base;
      for (let n = 2; usedNames.has(name); n += 1) {
        const suffix = ` ${n}`;
        name = `${base.slice(0, MATTER_LOCATION_NAME_MAX_LENGTH - suffix.length).trim()}${suffix}`;
      }
      usedNames.add(name);
      maps.push({ mapId: area.mapId, name });
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

  /**
   * The area ids in a SelectAreas request, in order and without repeats —
   * the same list matter.js stores — with what was dropped counted apart.
   */
  private readMatterAreaIds(newAreas: unknown): {
    areaIds: number[];
    unreadable: number;
    repeated: number;
  } {
    const areaIds: number[] = [];
    let unreadable = 0;
    let repeated = 0;
    if (!Array.isArray(newAreas)) {
      return { areaIds, unreadable, repeated };
    }

    const seenAreaIds = new Set<number>();
    for (const area of newAreas) {
      const areaId = this.getNumberFromValue(area);
      if (areaId === null || !Number.isInteger(areaId) || areaId < 0) {
        unreadable += 1;
      } else if (seenAreaIds.has(areaId)) {
        repeated += 1;
      } else {
        seenAreaIds.add(areaId);
        areaIds.push(areaId);
      }
    }

    return { areaIds, unreadable, repeated };
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

  /**
   * The location names to publish, made unique per map.
   *
   * matter.js 0.17.9 requires every area on one map to carry a different
   * AreaInfo, and the name is the only part of it that can differ here. Two
   * rooms the user named "Bedroom" therefore made the endpoint fail to
   * register at all ("Behaviors have errors"), and a later write fail
   * whole. The second and later ones get a number, in the order the robot
   * lists them, so the names stay stable from one publish to the next.
   */
  private withUniqueLocationNames(
    areas: MatterServiceArea[],
    includeMapName: boolean
  ): Array<{ area: MatterServiceArea; locationName: string }> {
    const usedByMap = new Map<number | null, Set<string>>();
    return areas.map((area) => {
      const base = this.getMatterLocationDisplayName(area, includeMapName);
      const mapKey = area.mapId ?? null;
      let used = usedByMap.get(mapKey);
      if (!used) {
        used = new Set();
        usedByMap.set(mapKey, used);
      }

      let locationName = base;
      for (let n = 2; used.has(locationName); n += 1) {
        const suffix = ` ${n}`;
        locationName = `${base.slice(0, MATTER_LOCATION_NAME_MAX_LENGTH - suffix.length).trim()}${suffix}`;
      }
      used.add(locationName);
      return { area, locationName };
    });
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

  /**
   * Whether the RvcCleanMode cluster is announced at all. Matter constrains
   * ModeBase SupportedModes to 2-255 entries, and matter.js 0.17.9 validates
   * an endpoint's whole initial state against the model when it registers
   * (ServerBehaviorBacking -> Datasource.validate), so a robot with no mop and
   * no announced suction levels — one mode, Vacuum — would not register. With
   * one mode there is no choice to offer, and the cluster is optional for an
   * RVC, so it is left out.
   */
  private isCleanModeEnabled(): boolean {
    return (
      this.platform.platformConfig.enableMatterCleanMode !== false &&
      this.getSupportedCleanModes().length >= 2
    );
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
   * The `operationalError` attribute as a whole, tank and robot alike.
   *
   * Separate from fault reporting above on purpose. That setting means "a
   * robot that has genuinely halted should say so instead of showing Ready".
   * An empty clean-water tank is not that: the robot is docked, charging, and
   * can vacuum all day. Folding the two together would change what a setting
   * already switched on by other people does to their tile, which is how
   * 3.3.0 got into trouble.
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

    // The plugin never maps a dock or tank condition to ERROR here. The 3.4.0
    // switch that did was withdrawn: it made a robot that could still vacuum
    // look unstartable. Note that matter.js 0.17.9 still shows Error while a
    // fault stands (#35) — which is why buildOperationalStateCluster() only
    // publishes one for a robot at rest.
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
      case 25: // Washing the mop (python-roborock washing_the_mop_2)
        return RVC_OPERATIONAL_STATE.CLEANING_MOP;
      case 29: // Mapping
        return RVC_OPERATIONAL_STATE.UPDATING_MAPS;
      case 100: // Fully Charged
        return RVC_OPERATIONAL_STATE.DOCKED;
      case ROBOROCK_BACK_TO_DOCK_WASHING_DUSTER:
        return RVC_OPERATIONAL_STATE.SEEKING_CHARGER;
      case 2: // Charger Disconnected
      case 3: // Idle: charge_status is 1 off the dock too (#28)
        return RVC_OPERATIONAL_STATE.STOPPED;
      default:
        if (isRoborockMoppingOnTheFloor(state)) {
          return RVC_OPERATIONAL_STATE.RUNNING;
        }
        // Before the default arm on purpose: Charging or Stopped is what made
        // a mop swap mid-run read as a finished run (see
        // isRoborockStateWithoutAMatterName).
        if (
          state !== null &&
          isRoborockStateWithoutAMatterName(state) &&
          this.lastNamedRoborockOperationalState !== null
        ) {
          return this.lastNamedRoborockOperationalState;
        }
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

  /** Take in one status frame from the robot: its fields and its state. */
  private rememberStatusFrame(status: Record<string, unknown>): void {
    this.rememberLiveStatusFrame(status);
    const state = this.getNumberFromValue(status.state);
    if (state !== null && !isRoborockStateWithoutAMatterName(state)) {
      this.lastNamedRoborockOperationalState = this.getRoborockOperationalState(
        state,
        this.getNumberStatus("charge_status")
      );
    }
  }

  /**
   * The clusters as matter.js holds them once written: a fault forces the
   * Error state (RvcOperationalStateServer#handleOperationalError). An
   * endpoint registered with this as its initial state starts there — and
   * matter.js emits no OperationalError event for an initial value.
   */
  private asRegistrationDefaults(
    clusters: MatterClusterState
  ): MatterClusterState {
    const cluster = clusters.rvcOperationalState;
    const errorStateId = (
      cluster?.operationalError as { errorStateId?: unknown } | undefined
    )?.errorStateId;
    if (
      !cluster ||
      typeof errorStateId !== "number" ||
      errorStateId === RVC_OPERATIONAL_ERROR.NO_ERROR
    ) {
      return clusters;
    }
    return {
      ...clusters,
      rvcOperationalState: {
        ...cluster,
        operationalState: RVC_OPERATIONAL_STATE.ERROR,
      },
    };
  }

  /**
   * Remember every numeric field of a live status frame, under its own name.
   *
   * Not a list of the fields somebody thought to read. A hand-written list is
   * what dropped the tank fields (3.10–3.12: the sensor and the fault could
   * never fire), `in_cleaning` (#28: Resume always restarted a paused room
   * clean as a whole-home run) and `water_box_mode` (#8: the clean mode
   * followed the 180-second HomeData snapshot instead of the robot). HomeData
   * is keyed by schema id and carries none of those, so a field the frame
   * carried and this method dropped had nowhere else to come from.
   */
  private rememberLiveStatusFrame(status: Record<string, unknown>): void {
    let remembered = false;
    for (const [field, raw] of Object.entries(status)) {
      const value = this.getNumberFromValue(raw);
      if (value !== null) {
        this.liveStatus.set(field, value);
        remembered = true;
      }
    }
    if (remembered) {
      this.liveStatusUpdatedAt = Date.now();
    }
  }

  private getNumberStatus(property: string): number | null {
    // Prefer the freshest value from a live message. A stale live cache must
    // not shadow the periodically refreshed cloud snapshot forever (dead
    // poller, connectivity loss), so a live value older than the staleness
    // window gives way to HomeData — but only for a field HomeData actually
    // has. HomeData is keyed by schema id and has no tank field, no
    // `in_cleaning`, no `dss`; for those the robot's last word, however old,
    // is the only evidence there is. Falling through to "unknown" instead let
    // HomeData's `error_code: 0` read as "nothing wrong" and withdraw a
    // standing tank fault after 15 quiet minutes, which the next reply then
    // raised again: a second notification for one empty tank (#26).
    const liveValue = this.liveStatus.get(property);
    if (
      liveValue !== undefined &&
      Date.now() - this.liveStatusUpdatedAt < LIVE_STATUS_STALENESS_MS
    ) {
      return liveValue;
    }

    const snapshotValue = this.getNumberFromValue(
      this.api.getVacuumDeviceStatus(this.getDuid(), property)
    );

    return snapshotValue ?? liveValue ?? null;
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

      // 120 is error_code. A robot that hits a fault mid-run can push a frame
      // carrying only this field, and until 3.13.0 it was dropped here — the
      // one transport on which a fault is most likely to arrive alone.
      if (Object.prototype.hasOwnProperty.call(dps, "120")) {
        status.error_code = dps["120"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "121")) {
        // Raw datapoints come from v1 robots only. A B01 robot's pushes never
        // reach this path: the library reads them in its own dialect and hands
        // them on as a v1-shaped status (onB01DatapointPush).
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
   *
   * A state that places the robot on the floor without cleaning answers the
   * question too (#28): a robot that stopped at a pin & go spot reported Idle
   * with charge_status 1 and read as docked 5 m from its dock. charge_status
   * is not stale there; robots report 1 off the dock (the a144 sends
   * `state: 18, charge_status: 1` in one get_status reply), and
   * python-roborock's get_dock_state() places the robot from the state alone.
   */
  private isRoborockDockedOrCharging(
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    if (roborockState === 8 || roborockState === 100) {
      return true;
    }

    if (
      this.isRoborockActivelyCleaningAwayFromDock(roborockState) ||
      isRoborockOnTheFloorAtRest(roborockState) ||
      isRoborockHeadingForTheDock(roborockState)
    ) {
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
    const updated = await this.publishRoborockSnapshot(
      this.buildClusters(),
      reason
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

  private clearOptimisticCluster(cluster: string): void {
    const optimistic = this.getActiveOptimisticState();
    if (!optimistic || !(cluster in optimistic)) {
      return;
    }

    const remaining = { ...optimistic };
    delete remaining[cluster];

    if (Object.keys(remaining).length === 0) {
      this.clearOptimisticState();
      return;
    }

    this.optimisticClusters = remaining;
    this.optimisticGeneration += 1;
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
    surface: string
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
        return isRoborockMoppingOnTheFloor(state);
    }
  }

  private async recoverMatterStateAfterFailedCommand(
    action: string
  ): Promise<void> {
    // A start that failed cleaned nothing; a failed command of any other kind
    // finds no start waiting here.
    this.restoreServiceAreaProgressFromBeforeStart();
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

  private logMatterCommandDuration(
    action: string,
    startedAt: number,
    surface: string
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
