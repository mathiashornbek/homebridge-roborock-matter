"use strict";

// A Roborock dock spends most of its day working. It empties the dust bin,
// washes the mop, updates the map — and then it spends 2 to 4 hours blowing
// air through a wet mop, every single time the robot mops.
//
// Matter has an operational state for 3 of those 4. Emptying the dust bin is
// 0x43, washing the mop is 0x44, updating maps is 0x46, and this plugin has
// published all 3 since 3.12.0. There is no state for drying, in any revision
// of the specification. The only place the fact can be expressed at all is
// `PhaseList` / `CurrentPhase` on the same cluster, which this plugin has sent
// as null since 1.4.58.
//
// The nulls were not a rule, though this file used to say they were. 1.4.58
// removed a version that changed phases as a REFRESH HACK — deliberate
// flapping, to make hubs re-read the accessory — and it flapped them against
// every Apple Home hub in the house. That is an argument against a moving
// list, not against having one.
//
// So the design is: the list is a module constant that never changes, and
// only CurrentPhase moves. The guard for that is in this file and it is the
// most important test here, because it is the one protecting against the
// failure that has actually happened.
//
// Whether Apple Home draws a phase at all is unmeasured. Nothing is lost if it
// does not: an unread attribute costs nothing, and drying is worth the attempt
// because no other route to it exists.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const b01 = require("../roborockLib/lib/b01Q7Adapter");

const PHASES = [
  "Emptying dust bin",
  "Washing mop",
  "Drying mop",
  "Updating maps",
];
const PHASE_EMPTYING = 0;
const PHASE_WASHING = 1;
const PHASE_DRYING = 2;
const PHASE_UPDATING_MAPS = 3;

const RVC_OPERATIONAL_STATE_RUNNING = 1;
const RVC_OPERATIONAL_STATE_CHARGING = 65;
const RVC_OPERATIONAL_STATE_DOCKED = 66;

const ROBOROCK_STATE_IDLE = 3;
const ROBOROCK_STATE_CLEANING = 5;
const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_EMPTYING = 22;
const ROBOROCK_STATE_WASHING_MOP = 23;
const ROBOROCK_STATE_MAPPING = 29;

function createPlatform({ status = {}, matterUpdates = [], config = {} } = {}) {
  const publish = jest.fn(async (uuid, cluster, attributes) => {
    matterUpdates.push({ cluster, attributes });
  });

  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    platformConfig: {
      enableMatter: true,
      enableMatterPowerSource: true,
      ...config,
    },
    getMatterApi: () => ({ updateAccessoryState: publish }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Stueetage" : "",
      getProductAttribute: () => "roborock.vacuum.a70",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function buildVacuum(options = {}) {
  const matterUpdates = options.matterUpdates ?? [];
  const platform = createPlatform({ ...options, matterUpdates });
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { vacuum, platform, matterUpdates };
}

function lastCluster(matterUpdates) {
  for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
    if (matterUpdates[i].cluster === "rvcOperationalState") {
      return matterUpdates[i].attributes;
    }
  }
  return undefined;
}

async function publishWith(status, config) {
  const { vacuum, matterUpdates, platform } = buildVacuum({ status, config });
  await vacuum.updateMatterStateFromRoborock("test");
  return { cluster: lastCluster(matterUpdates), platform };
}

describe("the phase list is announced and never moves", () => {
  test("it is exactly the dock's 4 jobs, in order", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
    });

    expect(cluster.phaseList).toEqual(PHASES);
  });

  test("it is byte-for-byte the same list in every state the robot can be in", async () => {
    // THE LOAD-BEARING TEST. 1.4.58 was removed for changing this attribute;
    // a rewritten list is what flapped against the hubs. If a future edit
    // makes the list depend on the robot at all, this fails.
    const everyState = [
      { state: ROBOROCK_STATE_IDLE },
      { state: ROBOROCK_STATE_CLEANING },
      { state: ROBOROCK_STATE_CHARGING, battery: 100 },
      { state: ROBOROCK_STATE_CHARGING, battery: 40 },
      { state: ROBOROCK_STATE_EMPTYING },
      { state: ROBOROCK_STATE_WASHING_MOP },
      { state: ROBOROCK_STATE_MAPPING },
      { state: ROBOROCK_STATE_CHARGING, dry_status: 1 },
      { state: ROBOROCK_STATE_IDLE, dry_status: 0 },
      { state: 12, error_code: 8 },
      { state: ROBOROCK_STATE_CHARGING, dock_error_status: 38 },
      {},
    ];

    const seen = [];
    for (const status of everyState) {
      const { cluster } = await publishWith({ battery: 80, ...status });
      seen.push(JSON.stringify(cluster.phaseList));
    }

    expect(new Set(seen).size).toBe(1);
    expect(JSON.parse(seen[0])).toEqual(PHASES);
  });

  test("the published list is a copy, so one publish cannot corrupt the next", async () => {
    // A shared module constant handed straight to the Matter layer would be
    // one accidental in-place edit away from a list that really does change,
    // which is the failure the constant exists to prevent. Each publish gets
    // its own array.
    const { vacuum, matterUpdates } = buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });

    await vacuum.updateMatterStateFromRoborock("test");
    const first = lastCluster(matterUpdates).phaseList;
    const publishedSoFar = matterUpdates.length;
    first.push("Something a controller wrote back");
    first[0] = "Corrupted";

    // A publish only happens when something changed, so give it something.
    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_WASHING_MOP },
    ]);
    expect(matterUpdates.length).toBeGreaterThan(publishedSoFar);

    expect(lastCluster(matterUpdates).phaseList).toEqual(PHASES);
    expect(lastCluster(matterUpdates).phaseList).not.toBe(first);
  });

  test("whatever CurrentPhase says, it indexes something real", async () => {
    // Matter requires CurrentPhase to be null or a valid index into
    // PhaseList, and matter.js validates it on the way in. An out-of-range
    // index would not be a cosmetic bug; it would refuse the write.
    const statuses = [
      { state: ROBOROCK_STATE_EMPTYING },
      { state: ROBOROCK_STATE_WASHING_MOP },
      { state: ROBOROCK_STATE_MAPPING },
      { state: ROBOROCK_STATE_CHARGING, dry_status: 1 },
      { state: ROBOROCK_STATE_CLEANING },
      { state: ROBOROCK_STATE_IDLE },
      {},
    ];

    for (const status of statuses) {
      const { cluster } = await publishWith({ battery: 80, ...status });
      const phase = cluster.currentPhase;
      if (phase === null) {
        continue;
      }
      expect(Number.isInteger(phase)).toBe(true);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(cluster.phaseList.length);
    }
  });
});

describe("the current phase names what the dock is doing", () => {
  const CASES = [
    ["emptying the dust bin", ROBOROCK_STATE_EMPTYING, PHASE_EMPTYING],
    ["washing the mop", ROBOROCK_STATE_WASHING_MOP, PHASE_WASHING],
    ["updating the map", ROBOROCK_STATE_MAPPING, PHASE_UPDATING_MAPS],
  ];

  test.each(CASES)("%s is phase %i", async (_label, state, expected) => {
    const { cluster } = await publishWith({ state, battery: 80 });
    expect(cluster.currentPhase).toBe(expected);
  });

  test("drying the mop is phase 2, and it is the reason this feature exists", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dry_status: 1,
    });

    expect(cluster.currentPhase).toBe(PHASE_DRYING);
  });

  test("a finished dry puts the phase out", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dry_status: 0,
    });

    expect(cluster.currentPhase).toBeNull();
  });

  test("a robot with no drying dock has no phase, not a false one", async () => {
    // `dry_status` is declared only for models whose capability bitmask says
    // they dry. A robot that never reports it must not be described as dry,
    // wet, or anything else.
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
    });

    expect(cluster.currentPhase).toBeNull();
  });

  test("washing outranks drying while both look true", async () => {
    // The dock reports drying as a mode it is in, and it does not always drop
    // the flag the instant a wash starts. Washing is the more useful of the 2
    // to show, and it is the one the robot states outright.
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_WASHING_MOP,
      battery: 90,
      dry_status: 1,
    });

    expect(cluster.currentPhase).toBe(PHASE_WASHING);
  });

  test("a robot out cleaning has no dock phase", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CLEANING,
      battery: 70,
    });

    expect(cluster.currentPhase).toBeNull();
  });

  test("a robot merely charging has no dock phase", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 55,
    });

    expect(cluster.currentPhase).toBeNull();
  });
});

describe("the phase does not disturb anything else on the tile", () => {
  test("drying leaves the robot docked, not running", async () => {
    // The whole point of mapping B01 status 10 to v1 state 8 was that a
    // drying dock must not look like a working robot. A phase must not undo
    // that: Apple may refuse a Start command to a robot it thinks is busy.
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      charge_status: 1,
      dry_status: 1,
    });

    expect(cluster.currentPhase).toBe(PHASE_DRYING);
    expect([
      RVC_OPERATIONAL_STATE_CHARGING,
      RVC_OPERATIONAL_STATE_DOCKED,
    ]).toContain(cluster.operationalState);
  });

  test("drying is not a fault", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dry_status: 1,
      error_code: 0,
    });

    expect(cluster.operationalError).toEqual({ errorStateId: 0 });
  });

  test("turning the extended states off does not silence the phase", async () => {
    // Someone who switches those states off has asked for a plainer tile, not
    // for the dock to stop saying what it is doing. The state goes generic;
    // the phase still names the job, which is exactly what the base cluster
    // describes a phase as being.
    const { cluster } = await publishWith(
      { state: ROBOROCK_STATE_WASHING_MOP, battery: 90 },
      { enableMatterExtendedOperationalStates: false }
    );

    expect(cluster.operationalState).toBe(RVC_OPERATIONAL_STATE_RUNNING);
    expect(cluster.currentPhase).toBe(PHASE_WASHING);
  });
});

describe("the escape hatch", () => {
  test("`enableMatterDockPhases: false` puts both attributes back to null", async () => {
    // Not on the settings page, on purpose. It is here because a controller
    // that dislikes an attribute can leave a tile unusable, and a line in
    // config.json is the difference between that and a reinstall.
    const { cluster } = await publishWith(
      {
        state: ROBOROCK_STATE_CHARGING,
        battery: 100,
        dry_status: 1,
      },
      { enableMatterDockPhases: false }
    );

    expect(cluster.phaseList).toBeNull();
    expect(cluster.currentPhase).toBeNull();
  });

  test("leaving it unset gets the feature, because the default is what people get", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dry_status: 1,
    });

    expect(cluster.phaseList).toEqual(PHASES);
    expect(cluster.currentPhase).toBe(PHASE_DRYING);
  });

  test("`true` written out explicitly behaves the same as unset", async () => {
    const { cluster } = await publishWith(
      { state: ROBOROCK_STATE_CHARGING, battery: 100, dry_status: 1 },
      { enableMatterDockPhases: true }
    );

    expect(cluster.currentPhase).toBe(PHASE_DRYING);
  });
});

describe("a B01/Q7 dock reaches the same phase by a different road", () => {
  test("the adapter carries raw status 10 through as dry_status", () => {
    expect(b01.mapStatusToV1({ status: 10, quantity: 99 })).toMatchObject({
      state: 8,
      charge_status: 1,
      dry_status: 1,
    });
  });

  test("and the accessory turns that into the drying phase", async () => {
    // End to end on the shape the adapter actually emits, because the mapping
    // is only useful if the far end reads it.
    const { vacuum, matterUpdates } = buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      b01.mapStatusToV1({ status: 10, quantity: 99 }),
    ]);

    expect(lastCluster(matterUpdates).currentPhase).toBe(PHASE_DRYING);
  });

  test("a B01 robot that finishes drying goes quiet again", async () => {
    const { vacuum, matterUpdates } = buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      b01.mapStatusToV1({ status: 10, quantity: 99 }),
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [
      b01.mapStatusToV1({ status: 4, quantity: 100 }),
    ]);

    expect(lastCluster(matterUpdates).currentPhase).toBeNull();
  });

  test("a B01 robot washing the mop reports washing, not drying", async () => {
    const { vacuum, matterUpdates } = buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      b01.mapStatusToV1({ status: 9, quantity: 88 }),
    ]);

    expect(lastCluster(matterUpdates).currentPhase).toBe(PHASE_WASHING);
  });
});

describe("drying survives the journey from a live message", () => {
  // The 3.12.1 lesson for the third time. Drying is a DOCK job: it starts
  // while the robot is parked and idle, which is exactly when the live frames
  // are sparsest and the cloud snapshot is stalest. If `dry_status` is not
  // remembered, the phase lights for 1 frame and goes out on the next
  // heartbeat — worse than never showing it.
  function liveHarness() {
    return buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });
  }

  test("a live frame carrying only dry_status lights the phase", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [{ dry_status: 1 }]);

    expect(lastCluster(matterUpdates).currentPhase).toBe(PHASE_DRYING);
  });

  test("a later frame that omits the field does not put it out", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_CHARGING, charge_status: 1, dry_status: 1 },
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [{ battery: 99 }]);

    expect(lastCluster(matterUpdates).currentPhase).toBe(PHASE_DRYING);
  });

  test("the dock saying it has finished does put it out", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_CHARGING, charge_status: 1, dry_status: 1 },
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [{ dry_status: 0 }]);

    expect(lastCluster(matterUpdates).currentPhase).toBeNull();
  });

  test("a whole mop run reads as one sequence, not a flicker", async () => {
    // The sequence a real dock produces: clean, come home, wash, dry for
    // hours, then sit. The phase should step through it once and hold each
    // step, and the list must be identical at every step.
    const { vacuum, matterUpdates } = liveHarness();

    const sequence = [
      [{ state: ROBOROCK_STATE_CLEANING, battery: 80 }, null],
      [{ state: ROBOROCK_STATE_WASHING_MOP }, PHASE_WASHING],
      [
        { state: ROBOROCK_STATE_CHARGING, charge_status: 1, dry_status: 1 },
        PHASE_DRYING,
      ],
      [{ battery: 95 }, PHASE_DRYING],
      [{ battery: 99 }, PHASE_DRYING],
      [{ dry_status: 0 }, null],
      [{ battery: 100 }, null],
    ];

    const lists = [];
    for (const [frame, expected] of sequence) {
      await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
      const cluster = lastCluster(matterUpdates);
      expect(cluster.currentPhase).toBe(expected);
      lists.push(JSON.stringify(cluster.phaseList));
    }

    expect(new Set(lists).size).toBe(1);
  });
});
