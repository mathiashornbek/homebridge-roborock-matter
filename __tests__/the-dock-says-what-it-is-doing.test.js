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

describe("matter.js will reject the write, so the write must obey matter.js", () => {
  // THE TEST THAT SHOULD HAVE EXISTED IN 3.14.0.
  //
  // Every other test in this file publishes into a mock, which cheerfully
  // accepts anything. The real server does not. From matter.js's own
  // `OperationalStateServer`, read off the Homebridge host:
  //
  //   #assertCurrentPhase(currentPhase) {
  //     if (this.state.phaseList === null || this.state.phaseList.length === 0) {
  //       if (currentPhase === null) return;
  //       throw new ImplementationError("Cannot set current phase to an other
  //         value than null when phase list is empty");
  //     }
  //     if (currentPhase === null || currentPhase < 0 ||
  //         currentPhase >= this.state.phaseList.length) {
  //       throw new ImplementationError(`Current phase ${currentPhase} is out
  //         of bounds for phase list of length ${this.state.phaseList.length}`);
  //     }
  //   }
  //
  // A null CurrentPhase beside a non-empty PhaseList throws. Homebridge
  // swallows the throw, so the ENTIRE cluster write is silently discarded and
  // the controller keeps whatever it last accepted.
  //
  // 3.14.0 published a constant list with a null phase whenever the dock was
  // idle — which is nearly always. Measured on a real mop run: the tile read
  // "Cleaning Mop" for 5 minutes while the robot mopped the hall, because the
  // last write matter.js had accepted was the one where the dock really was
  // washing the mop. Every operational state after that was thrown away. Not
  // the phase — the state, the battery, the fault, all of it.
  //
  // So this test does not check the feature. It checks that what the plugin
  // hands the Matter layer is something the Matter layer will take.
  const EVERY_SITUATION = [
    { state: ROBOROCK_STATE_IDLE },
    { state: ROBOROCK_STATE_CLEANING },
    { state: ROBOROCK_STATE_CLEANING, dry_status: 0 },
    { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    { state: ROBOROCK_STATE_CHARGING, battery: 40 },
    { state: ROBOROCK_STATE_EMPTYING },
    { state: ROBOROCK_STATE_WASHING_MOP },
    { state: ROBOROCK_STATE_MAPPING },
    { state: ROBOROCK_STATE_CHARGING, dry_status: 1 },
    { state: ROBOROCK_STATE_CHARGING, dry_status: 0 },
    { state: ROBOROCK_STATE_WASHING_MOP, dry_status: 1 },
    { state: 6 },
    { state: 10 },
    { state: 12, error_code: 8 },
    { state: 15 },
    { state: 26 },
    { state: ROBOROCK_STATE_CHARGING, dock_error_status: 38 },
    {},
  ];

  test.each(EVERY_SITUATION)(
    "the pair is one matter.js accepts: %o",
    async (status) => {
      const { cluster } = await publishWith({ battery: 80, ...status });
      const { phaseList, currentPhase } = cluster;

      // An empty array is rejected outright by the first branch above unless
      // the phase is null, and it says nothing anyone wants to hear. Never
      // publish one.
      expect(phaseList).not.toEqual([]);

      if (phaseList === null) {
        expect(currentPhase).toBeNull();
        return;
      }

      expect(Array.isArray(phaseList)).toBe(true);
      expect(phaseList.length).toBeGreaterThan(0);
      expect(currentPhase).not.toBeNull();
      expect(Number.isInteger(currentPhase)).toBe(true);
      expect(currentPhase).toBeGreaterThanOrEqual(0);
      expect(currentPhase).toBeLessThan(phaseList.length);
    }
  );

  test("and it holds across a whole run, frame by frame, on the live path", async () => {
    // The static check above builds each state from a fresh accessory. This
    // one carries state forward the way a real robot does, because the
    // 3.14.0 failure only appeared on the TRANSITION out of a dock job.
    const { vacuum, matterUpdates } = buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });

    const run = [
      { state: ROBOROCK_STATE_WASHING_MOP },
      { state: ROBOROCK_STATE_CLEANING, battery: 99 },
      { state: ROBOROCK_STATE_CHARGING, charge_status: 1, dry_status: 1 },
      { battery: 100 },
      { dry_status: 0 },
      { state: ROBOROCK_STATE_EMPTYING },
      { state: ROBOROCK_STATE_IDLE },
    ];

    let checked = 0;
    for (const frame of run) {
      await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
      const cluster = lastCluster(matterUpdates);
      if (!cluster) {
        continue;
      }
      const { phaseList, currentPhase } = cluster;
      if (phaseList === null) {
        expect(currentPhase).toBeNull();
      } else {
        expect(currentPhase).not.toBeNull();
        expect(currentPhase).toBeLessThan(phaseList.length);
      }
      checked += 1;
    }

    expect(checked).toBe(run.length);
  });

  test("the list is assigned before the index, because matter.js validates in that order", () => {
    // matter.js reads `this.state.phaseList` while validating currentPhase, so
    // an object that names the index first would be validated against the
    // PREVIOUS list. Leaving a 4-entry list for none would then throw on the
    // way out. Key order in the published object is therefore load-bearing.
    const source = require("fs").readFileSync(
      require.resolve("../src/matter_vacuum_accessory.ts"),
      "utf8"
    );
    const listAt = source.indexOf("phaseList: dockPhase === null");
    const phaseAt = source.indexOf("currentPhase: dockPhase,");

    expect(listAt).toBeGreaterThan(-1);
    expect(phaseAt).toBeGreaterThan(listAt);
  });
});

describe("the phase list is announced and never moves", () => {
  test("it is exactly the dock's 4 jobs, in order, whenever it is present", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_WASHING_MOP,
      battery: 90,
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

    const seen = new Set();
    for (const status of everyState) {
      const { cluster } = await publishWith({ battery: 80, ...status });
      if (cluster.phaseList !== null) {
        seen.add(JSON.stringify(cluster.phaseList));
      }
    }

    expect(seen.size).toBe(1);
    expect(JSON.parse([...seen][0])).toEqual(PHASES);
  });

  test("the published list is a copy, so one publish cannot corrupt the next", async () => {
    // A shared module constant handed straight to the Matter layer would be
    // one accidental in-place edit away from a list that really does change,
    // which is the failure the constant exists to prevent. Each publish gets
    // its own array.
    const { vacuum, matterUpdates } = buildVacuum({
      status: { state: ROBOROCK_STATE_WASHING_MOP, battery: 100 },
    });

    await vacuum.updateMatterStateFromRoborock("test");
    const first = lastCluster(matterUpdates).phaseList;
    const publishedSoFar = matterUpdates.length;
    first.push("Something a controller wrote back");
    first[0] = "Corrupted";

    // A publish only happens when something changed, so give it something.
    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_EMPTYING },
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

  test("an idle dock publishes no list at all, not an unused one", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
    });

    expect(cluster.phaseList).toBeNull();
    expect(cluster.currentPhase).toBeNull();
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

    const lists = new Set();
    for (const [frame, expected] of sequence) {
      await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
      const cluster = lastCluster(matterUpdates);
      expect(cluster.currentPhase).toBe(expected);
      if (cluster.phaseList !== null) {
        lists.add(JSON.stringify(cluster.phaseList));
      }
    }

    expect(lists.size).toBe(1);
  });
});

describe("the publish line reports the phase, because the feature is unmeasured", () => {
  // Without this, a tile that shows nothing during a dry is ambiguous: the
  // controller ignored the attribute, or the plugin never sent it. That
  // ambiguity is what cost the tank warning 2 releases and 3 field tests.
  function publishLines(platform) {
    return platform.log.info.mock.calls
      .concat(platform.log.debug.mock.calls)
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Matter publish for"));
  }

  test("a drying dock says so in the log, by name", async () => {
    const { platform } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dry_status: 1,
    });

    expect(
      publishLines(platform).some((line) => line.includes("phase=Drying mop"))
    ).toBe(true);
  });

  test("washing the mop says that instead", async () => {
    const { platform } = await publishWith({
      state: ROBOROCK_STATE_WASHING_MOP,
      battery: 90,
    });

    expect(
      publishLines(platform).some((line) => line.includes("phase=Washing mop"))
    ).toBe(true);
  });

  test("a robot doing nothing in particular says nothing about phases", async () => {
    const { platform } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 55,
    });

    const lines = publishLines(platform);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("phase=");
    }
  });
});
