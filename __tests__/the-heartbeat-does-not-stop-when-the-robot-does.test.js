"use strict";

// Issue #7 turns on a claim that is now public: while a robot sits docked with
// nothing changing, the plugin still submits a complete cluster snapshot every
// 60 seconds, forever, and it is matter.js that drops those writes because the
// values are deeply equal to the ones already stored (`Datasource.js`,
// `#computePostCommitChanges`). That division of labour is the whole diagnosis
// — it says the silence a controller sees during idle is not the plugin going
// quiet, so a tile that decays is a keepalive/network question rather than a
// publishing one.
//
// The existing heartbeat tests cover one or two beats: that a forced beat
// rewrites everything (matter-vacuum), that a failed beat re-arms and that
// dispose stops it (robustness-hardening). None of them pins the property the
// diagnosis rests on, which is that the beat is never gated on the robot being
// awake and never slows down when nothing changes. That gap is the shape of a
// plausible future optimisation: someone sees ~240 writes an hour land in
// matter.js and get discarded, and "skip the pointless ones while docked"
// reads as a tidy-up rather than as the silent invalidation of a diagnosis
// already given to a user.
//
// So this enumerates the rule rather than a case: across every resting state a
// robot can hold, over a window far longer than any test here has used, the
// beat count is a function of elapsed time alone.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const HEARTBEAT_MS = 60 * 1000;

afterEach(() => {
  jest.useRealTimers();
});

function createPlatform(status) {
  const matterUpdates = [];
  const updateAccessoryState = jest.fn(async (uuid, cluster, attributes) => {
    matterUpdates.push({ uuid, cluster, attributes });
  });
  return {
    matterUpdates,
    platform: {
      platformConfig: {
        enableMatter: true,
        enableMatterServiceArea: true,
        enableMatterPowerSource: true,
        enableMatterCleanMode: true,
        enableMatterExtendedOperationalStates: false,
        preferCloudForMatterCommands: false,
      },
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      getMatterApi: () => ({ updateAccessoryState }),
      shouldAcceptUnscopedLiveMessage: () => true,
      roborockAPI: {
        getVacuumDeviceInfo: (duid, property) =>
          property === "name" ? "Test Vacuum" : "",
        getProductAttribute: () => "roborock.vacuum.sc05",
        getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
        getRoomMappingsForDevice: () => [],
        getMapListForDevice: () => [],
        getCurrentMapIdForDevice: () => null,
        getMatterCleanModeCapabilities: () => ({
          canVacuum: true,
          canMop: false,
        }),
        app_start: jest.fn().mockResolvedValue(undefined),
        app_stop: jest.fn().mockResolvedValue(undefined),
        app_pause: jest.fn().mockResolvedValue(undefined),
        app_charge: jest.fn().mockResolvedValue(undefined),
        applyMatterCleanModeSettings: jest.fn().mockResolvedValue(undefined),
        find_me: jest.fn().mockResolvedValue(undefined),
        app_segment_clean_by_ids: jest.fn().mockResolvedValue(undefined),
        load_multi_map: jest.fn().mockResolvedValue(undefined),
        getStatus: jest.fn().mockResolvedValue(undefined),
      },
    },
  };
}

/**
 * Arm the heartbeat with one real publish, then let exactly one beat land so
 * the size of a beat is measured rather than assumed. The arming publish is a
 * poor yardstick: it carries one extra `powerSource` write for the once-per-boot
 * battery resync, so anything counted against it is off by one for the life of
 * the test.
 *
 * Returns a counter anchored after that first beat, so every assertion below
 * talks about whole beats.
 */
async function armedAndBeating(status) {
  const { platform, matterUpdates } = createPlatform(status);
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    { UUID: "uuid-1", context: { duid: "device-1" } },
    { duid: "device-1" },
    true
  );

  await vacuum.updateMatterStateFromRoborock();
  expect(matterUpdates.length).toBeGreaterThan(0);

  const beforeFirstBeat = matterUpdates.length;
  await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
  const clustersPerBeat = matterUpdates.length - beforeFirstBeat;

  // If this is zero the heartbeat never fired at all and every count below
  // would trivially agree with a broken implementation.
  expect(clustersPerBeat).toBeGreaterThan(0);

  const anchor = matterUpdates.length;
  return {
    vacuum,
    matterUpdates,
    clustersPerBeat,
    firstBeatClusters: matterUpdates
      .slice(beforeFirstBeat, anchor)
      .map((update) => update.cluster)
      .sort(),
    beatsSince: () => (matterUpdates.length - anchor) / clustersPerBeat,
    writesSince: () => matterUpdates.length - anchor,
  };
}

// Everything a robot can be while it is not doing anything: charging, full,
// idle on the floor, asleep, and stopped mid-clean. Not one of these may buy
// the controller a slower heartbeat.
const RESTING_STATES = [
  {
    label: "charging in the dock",
    status: { state: 8, charge_status: 1, battery: 100 },
  },
  {
    label: "fully charged in the dock",
    status: { state: 100, charge_status: 1, battery: 100 },
  },
  {
    label: "idle away from the dock",
    status: { state: 3, charge_status: 0, battery: 84 },
  },
  { label: "asleep", status: { state: 0, charge_status: 0, battery: 100 } },
  {
    label: "paused mid-clean",
    status: { state: 10, charge_status: 0, battery: 61 },
  },
];

describe("the Matter heartbeat is a function of elapsed time, not of robot activity", () => {
  test.each(RESTING_STATES)(
    "keeps beating for half an hour while $label and nothing changes",
    async ({ status }) => {
      jest.useFakeTimers();
      const { beatsSince } = await armedAndBeating(status);

      const minutes = 30;
      await jest.advanceTimersByTimeAsync(minutes * HEARTBEAT_MS);

      // One forced full snapshot per minute, every minute, with no fresh
      // readings in between: the robot has not moved and the values are
      // byte-identical, which is exactly when it must not stop.
      expect(beatsSince()).toBe(minutes);
    }
  );

  test("does not decay over an idle window as long as the one measured in the field", async () => {
    jest.useFakeTimers();
    const { beatsSince } = await armedAndBeating({
      state: 8,
      charge_status: 1,
      battery: 100,
    });

    // 162 minutes is the real gap between two restarts on the maintainer's
    // server during which three docked robots produced no attribute change at
    // all. Sampled along the way rather than asserted once at the end, so a
    // heartbeat that backs off fails on the interval where it backed off
    // instead of hiding inside a single total.
    let elapsed = 0;
    for (const minute of [1, 5, 15, 60, 120, 162]) {
      await jest.advanceTimersByTimeAsync((minute - elapsed) * HEARTBEAT_MS);
      elapsed = minute;
      expect(beatsSince()).toBe(minute);
    }
  });

  test("the interval is 60 seconds exactly, not merely 'about a minute'", async () => {
    jest.useFakeTimers();
    const { writesSince, clustersPerBeat } = await armedAndBeating({
      state: 8,
      charge_status: 1,
      battery: 100,
    });

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(writesSince()).toBe(0);

    await jest.advanceTimersByTimeAsync(1);
    expect(writesSince()).toBe(clustersPerBeat);
  });

  test("every beat carries the full cluster set, never a diff", async () => {
    jest.useFakeTimers();
    const { matterUpdates, clustersPerBeat, firstBeatClusters } =
      await armedAndBeating({ state: 8, charge_status: 1, battery: 100 });

    const anchor = matterUpdates.length;
    await jest.advanceTimersByTimeAsync(3 * HEARTBEAT_MS);

    for (let beat = 0; beat < 3; beat += 1) {
      const start = anchor + beat * clustersPerBeat;
      const beatClusters = matterUpdates
        .slice(start, start + clustersPerBeat)
        .map((update) => update.cluster)
        .sort();
      // A diff would shrink to nothing here, because nothing changed. That is
      // the point of forcing: the write must reach matter.js and be discarded
      // there, not be withheld here on a guess about what matter.js holds.
      expect(beatClusters).toEqual(firstBeatClusters);
    }
  });
});
