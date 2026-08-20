"use strict";

// The Matter fault attribute has been in and out of this plugin twice. 1.4.61
// wrote it and removed it; 3.3.0 brought it back for issue #5 and 3.4.1 took
// it out again after 3 controlled tests on Wazza151's S8 Pro Ultra with a
// genuinely empty clean-water tank: Apple Home drew no warning beside a
// Charging state, drew no warning beside a forced Error state either, and the
// tile wedged on "Updating…".
//
// What brought it back a third time is a counterexample rather than an
// argument. vp-debug12 posted a screenshot in issue #9 of the same attribute
// rendered correctly by the same controller — tap icon on the play button,
// localised "refill the water tank". So "Apple never draws these" is false,
// and the condition separating the 2 results is still unknown.
//
// This file pins the narrow shape that decision produced, because the shape is
// the whole safety argument:
//
//   1. WaterTankEmpty (68) is published when the robot says the tank is empty,
//      and NoError (0) when it says it is full. An attribute only ever written
//      when something is wrong never clears, and a warning that will not go
//      away after a refill is worse than no warning.
//   2. The operational state is NOT dragged to Error with it. Wazza151's third
//      test did exactly that and Apple still drew nothing, so it buys nothing
//      measured — and a robot in Error may be refused a Start command, which
//      is a real cost for a robot that is docked, charging, and perfectly able
//      to vacuum without water.
//   3. A robot that has not reported its tank at all gets no attribute, not a
//      cheerful NoError. Clearing a warning nobody contradicted is inventing
//      data, which is the one thing this plugin does not do.
//   4. It is its own config key, so it can be switched off without losing the
//      Error state feature. Bundling those 2 is the mistake 3.3.0 made.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RVC_OPERATIONAL_STATE_ERROR = 3;
const RVC_ERROR_NONE = 0;
const RVC_ERROR_WATER_TANK_EMPTY = 68;

const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_CLEANING = 5;

function createPlatform({ status = {}, matterUpdates = [], tank } = {}) {
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
      // Left undefined on purpose in most cases: the point of 3.12.0 is that
      // the plugin default is what a user actually gets.
      enableMatterTankFaultReporting: tank,
    },
    getMatterApi: () => ({ updateAccessoryState: publish }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Vicky" : "",
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

async function publishWith(status, tank) {
  const matterUpdates = [];
  const platform = createPlatform({ status, matterUpdates, tank });
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  await vacuum.updateMatterStateFromRoborock("test");

  let cluster;
  for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
    if (matterUpdates[i].cluster === "rvcOperationalState") {
      cluster = matterUpdates[i].attributes;
      break;
    }
  }
  return { cluster, platform, accessory };
}

describe("an empty clean-water tank reaches the Apple Home tile", () => {
  // Both measured robots, and they do not agree on how they say it: the a70
  // sets only the dock code, the a75 sets both. Either has to be enough.
  const EMPTY = [
    [
      "an S8 Pro Ultra, which sets only the dock code (#5)",
      { dock_error_status: 38, water_shortage_status: 0 },
    ],
    [
      "a Q Revo, which sets both (#9)",
      { dock_error_status: 38, water_shortage_status: 1 },
    ],
    [
      "a robot with an onboard tank and no dock tank",
      { dock_error_status: 0, water_shortage_status: 1 },
    ],
  ];

  test.each(EMPTY)("%s publishes WaterTankEmpty", async (_label, frame) => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      ...frame,
    });

    expect(cluster.operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("a refilled tank clears it, rather than going quiet", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dock_error_status: 0,
      water_shortage_status: 0,
    });

    expect(cluster.operationalError).toEqual({
      errorStateId: RVC_ERROR_NONE,
    });
  });

  test("a robot that has not reported its tank gets no attribute at all", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
    });

    expect(cluster).not.toHaveProperty("operationalError");
  });

  test("an empty tank never makes a working robot look unstartable", async () => {
    // The load-bearing one. A docked robot with no water can still vacuum, and
    // Apple may refuse a Start command to a robot in Error.
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      error_code: 0,
      dock_error_status: 38,
    });

    expect(cluster.operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
    expect(cluster.operationalState).not.toBe(RVC_OPERATIONAL_STATE_ERROR);
  });

  test("it holds mid-clean too, not only on the dock", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CLEANING,
      battery: 70,
      water_shortage_status: 1,
    });

    expect(cluster.operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
    expect(cluster.operationalState).not.toBe(RVC_OPERATIONAL_STATE_ERROR);
  });

  test("`false` in config.json still switches it off completely", async () => {
    // The escape hatch is no longer on the settings page, so this is the only
    // thing standing between a user with a wedged tile and a reinstall.
    const { cluster } = await publishWith(
      {
        state: ROBOROCK_STATE_CHARGING,
        battery: 100,
        dock_error_status: 38,
      },
      false
    );

    expect(cluster).not.toHaveProperty("operationalError");
  });

  test("the publish line says which fault went out", async () => {
    // 3.4.1 removed the attribute and left the log rendering `fault=…` from a
    // value that was never written — a dead branch that read as evidence the
    // feature still existed. The field comes back only with something in it.
    const { platform } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dock_error_status: 38,
    });

    const lines = platform.log.info.mock.calls
      .concat(platform.log.debug.mock.calls)
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Matter publish for"));

    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.some((line) => line.includes("fault=68 (Clean water tank empty)"))
    ).toBe(true);
  });

  test("a healthy robot's publish line says nothing about faults", async () => {
    const { platform } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dock_error_status: 0,
      water_shortage_status: 0,
    });

    const lines = platform.log.info.mock.calls
      .concat(platform.log.debug.mock.calls)
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Matter publish for"));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("fault=");
    }
  });
});

describe("the tank fields survive the journey from a live message", () => {
  // The bug this file did not catch the first time, and the reason it did
  // not. Every test above stubs `getVacuumDeviceStatus`, so they prove the
  // logic and nothing about the plumbing. On a real robot the tank fields
  // arrive only in live messages: `getNumberStatus` reads the live cache
  // first and the HomeData snapshot second, and these 2 fields are in
  // neither unless the live handler remembers them.
  //
  // It did not. 3.10.0's Water Tank Empty sensor and 3.12.0's Matter fault
  // were both correct and both unable to fire, while the Roborock app showed
  // "Out of water" on the same dock. This test takes the robot's own route.
  function liveHarness() {
    const matterUpdates = [];
    // The snapshot knows nothing about tanks, exactly like the real one.
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
      matterUpdates,
    });
    const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: "device-1" },
      true
    );
    return { vacuum, matterUpdates };
  }

  function lastCluster(matterUpdates) {
    for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
      if (matterUpdates[i].cluster === "rvcOperationalState") {
        return matterUpdates[i].attributes;
      }
    }
    return undefined;
  }

  test("a live frame carrying only the dock code still reaches the tile", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      {
        state: ROBOROCK_STATE_CHARGING,
        battery: 100,
        charge_status: 1,
        dock_error_status: 38,
        water_shortage_status: 0,
      },
    ]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("a later frame that omits the field does not lose the warning", async () => {
    // Roborock sends sparse frames: one carries the tank, the next carries
    // only the battery. A warning that vanished on the next heartbeat would
    // be worse than no warning, and the live cache is what prevents it.
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      {
        state: ROBOROCK_STATE_CHARGING,
        charge_status: 1,
        dock_error_status: 38,
      },
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [{ battery: 99 }]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("a refill in a later frame clears it", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      {
        state: ROBOROCK_STATE_CHARGING,
        charge_status: 1,
        dock_error_status: 38,
      },
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [
      {
        state: ROBOROCK_STATE_CHARGING,
        charge_status: 1,
        dock_error_status: 0,
      },
    ]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_NONE,
    });
  });

  test("the onboard shortage flag travels the same way", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      {
        state: ROBOROCK_STATE_CLEANING,
        battery: 70,
        water_shortage_status: 1,
      },
    ]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });
});
