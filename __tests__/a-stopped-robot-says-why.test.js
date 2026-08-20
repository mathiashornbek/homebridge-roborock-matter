"use strict";

// Apple Home has always been able to show that one of these robots stopped.
// It has never been able to show why.
//
// The state was the easy half and it shipped long ago: Roborock state 9 or 12
// becomes Matter operational state 3 (Error), so a robot wedged under a sofa
// reads as Error rather than Ready. The reason is a separate attribute,
// `operationalError`, and until 3.13.0 exactly one value was ever written into
// it — WaterTankEmpty. Everything else the robot can tell you about itself
// (main brush blocked, wheel jammed, dust bin missing, bin full, dock
// unreachable, flat battery) sat in `errorCodes` in deviceFeatures.js, polled
// on every cycle since the fork, and shown to nobody.
//
// Two things in this file are load-bearing and neither is the mapping itself:
//
//   1. Nothing above id 71 is ever published. The accurate names for several
//      of these faults — WheelsJammed (76), BrushJammed (77),
//      NavigationSensorObscured (78) — are Matter 1.5. Ids 0-71 are 1.2. This
//      plugin has already measured what Apple does with an id it does not
//      recognise, in the neighbouring attribute: the tile sticks on
//      "Connecting" forever. A generic-but-known code is worth more than an
//      accurate-but-unknown one until somebody looks at a real tile.
//   2. The live path is tested, not just the logic. 3.12.1 exists because
//      the tank feature was correct for 2 releases and could never fire: the
//      fields it read were in neither the live cache nor the HomeData
//      snapshot. `error_code` had the same hole, including the dps frame that
//      is the most likely way a fault arrives on a B01/Q7.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RVC_ERROR_NONE = 0;
const RVC_ERROR_UNABLE_TO_START = 1;
const RVC_ERROR_UNABLE_TO_COMPLETE = 2;
const RVC_ERROR_FAILED_TO_FIND_DOCK = 64;
const RVC_ERROR_STUCK = 65;
const RVC_ERROR_DUST_BIN_MISSING = 66;
const RVC_ERROR_DUST_BIN_FULL = 67;
const RVC_ERROR_WATER_TANK_EMPTY = 68;

// The highest id the cluster defined before Matter 1.5.
const HIGHEST_MATTER_1_2_ERROR = 71;

const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_IN_ERROR = 12;

function createPlatform({ status = {}, matterUpdates = [], faults } = {}) {
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
      enableMatterTankFaultReporting: faults,
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

function buildVacuum(options) {
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

async function publishWith(status, faults) {
  const { vacuum, platform, matterUpdates } = buildVacuum({ status, faults });
  await vacuum.updateMatterStateFromRoborock("test");
  return { cluster: lastCluster(matterUpdates), platform };
}

function publishLines(platform) {
  return platform.log.info.mock.calls
    .concat(platform.log.debug.mock.calls)
    .map((call) => String(call[0]))
    .filter((line) => line.includes("Matter publish for"));
}

describe("a robot that stopped says what stopped it", () => {
  const CASES = [
    ["a robot stuck and unable to move", 8, RVC_ERROR_STUCK],
    ["a jammed drive wheel", 7, RVC_ERROR_STUCK],
    ["a wheel off the ground", 3, RVC_ERROR_STUCK],
    ["a robot tipped onto uneven ground", 16, RVC_ERROR_STUCK],
    ["a blocked main brush", 5, RVC_ERROR_UNABLE_TO_COMPLETE],
    ["a blocked side brush", 6, RVC_ERROR_UNABLE_TO_COMPLETE],
    ["a dirty laser sensor", 1, RVC_ERROR_UNABLE_TO_COMPLETE],
    ["a failed suction fan", 18, RVC_ERROR_UNABLE_TO_COMPLETE],
    ["a missing dust bin", 9, RVC_ERROR_DUST_BIN_MISSING],
    ["a full dust bin", 254, RVC_ERROR_DUST_BIN_FULL],
    ["an unpowered dock", 19, RVC_ERROR_FAILED_TO_FIND_DOCK],
    ["a dock it cannot reach", 23, RVC_ERROR_FAILED_TO_FIND_DOCK],
    ["a flat battery", 12, RVC_ERROR_UNABLE_TO_START],
    ["a no-go zone in the way", 24, RVC_ERROR_UNABLE_TO_START],
  ];

  test.each(CASES)("%s publishes %i as %i", async (_label, code, expected) => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_IN_ERROR,
      battery: 55,
      error_code: code,
    });

    expect(cluster.operationalError).toEqual({ errorStateId: expected });
  });

  test("an error_code this plugin has never seen publishes nothing", async () => {
    // The 3.13.1 correction, and it was measured rather than reasoned.
    // 3.13.0 gave an unknown code the generic fault on the grounds that
    // silence is worse than vagueness. Within the hour, 2 docked robots at
    // 100 % battery both carrying `error_code: 2105` had a fault drawn on
    // tiles with nothing wrong with them. The B01/Q7 fault field is a
    // diagnostic channel where informational codes linger — this repository's
    // own adapter zeroes 407 for that exact reason.
    const { cluster, platform } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      error_code: 2105,
    });

    expect(cluster).not.toHaveProperty("operationalError");
    expect(
      platform.log.info.mock.calls
        .map((call) => String(call[0]))
        .some(
          (line) =>
            line.includes("error_code 2105") &&
            line.includes("no mapping") &&
            line.includes("issues")
        )
    ).toBe(true);
  });

  test("the unmapped code is named once, not once per poll", async () => {
    const { vacuum, platform } = buildVacuum({
      status: {
        state: ROBOROCK_STATE_CHARGING,
        battery: 100,
        error_code: 2105,
      },
    });
    await vacuum.updateMatterStateFromRoborock("test");
    await vacuum.updateMatterStateFromRoborock("test");
    await vacuum.updateMatterStateFromRoborock("test");

    const named = platform.log.info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("error_code 2105"));
    expect(named).toHaveLength(1);
  });

  test("an unmapped code does not clear a fault the tank is still carrying", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dock_error_status: 38,
      error_code: 2105,
    });

    expect(cluster.operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("a B01/Q7 robot's fault channel is not read through the v1 table", async () => {
    // `matter_clean_type` is only reported by B01/Q7 robots, and their fault
    // numbers are a different space that happens to share a field name. 254
    // means "bin full" in Roborock's v1 table and means nothing established
    // on a Q7, so it must not be translated.
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      matter_clean_type: 1,
      error_code: 254,
    });

    expect(cluster).not.toHaveProperty("operationalError");
  });

  test("a healthy robot publishes NoError, so a cleared fault clears", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      error_code: 0,
    });

    expect(cluster.operationalError).toEqual({ errorStateId: RVC_ERROR_NONE });
  });

  test("a robot that reports neither a tank nor an error gets no attribute", async () => {
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
    });

    expect(cluster).not.toHaveProperty("operationalError");
  });

  test("an empty tank outranks the robot's own fault", async () => {
    // Both can be true at once on a docked robot. The tank is the one the user
    // can do something about in the next 30 seconds, and it is the only id in
    // this file measured rendering on a real tile.
    const { cluster } = await publishWith({
      state: ROBOROCK_STATE_CHARGING,
      battery: 100,
      dock_error_status: 38,
      error_code: 5,
    });

    expect(cluster.operationalError).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("the publish line names the fault and the Roborock text behind it", async () => {
    const { platform } = await publishWith({
      state: ROBOROCK_STATE_IN_ERROR,
      battery: 55,
      error_code: 5,
    });

    const lines = publishLines(platform);
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.some(
        (line) =>
          line.includes("fault=2 (Unable to complete operation") &&
          line.includes("Main brush blocked, Roborock 5") &&
          line.includes("BrushJammed (77)")
      )
    ).toBe(true);
  });

  test("`false` in config.json still switches the whole attribute off", async () => {
    const { cluster } = await publishWith(
      {
        state: ROBOROCK_STATE_IN_ERROR,
        battery: 55,
        error_code: 8,
      },
      false
    );

    expect(cluster).not.toHaveProperty("operationalError");
  });
});

describe("nothing newer than Matter 1.2 ever leaves the plugin", () => {
  // The safety rail. Ids 72-78 name several of these faults exactly and are
  // tempting; they are also 1.5, and this codebase has measured a tile stuck
  // on "Connecting" from an id Apple did not recognise in the neighbouring
  // attribute. If a future edit reaches for the accurate name, this fails.
  const EVERY_KNOWN_ROBOROCK_ERROR = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 254, 255,
  ];

  test.each(EVERY_KNOWN_ROBOROCK_ERROR)(
    "error_code %i maps inside the 1.2 range",
    async (code) => {
      const { cluster } = await publishWith({
        state: ROBOROCK_STATE_IN_ERROR,
        battery: 55,
        error_code: code,
      });

      const id = cluster.operationalError.errorStateId;
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(HIGHEST_MATTER_1_2_ERROR);
    }
  );
});

describe("a fault survives the journey from a live message", () => {
  // The 3.12.1 lesson, applied to the second field. Every test above stubs
  // getVacuumDeviceStatus, which proves the mapping and nothing about the
  // plumbing.
  function liveHarness() {
    return buildVacuum({
      status: { state: ROBOROCK_STATE_CHARGING, battery: 100 },
    });
  }

  test("a live frame carrying only error_code reaches the tile", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_IN_ERROR, error_code: 8 },
    ]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_STUCK,
    });
  });

  test("a later frame that omits the field does not lose the fault", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_IN_ERROR, error_code: 9 },
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [{ battery: 99 }]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_DUST_BIN_MISSING,
    });
  });

  test("clearing the fault in a later frame clears the attribute", async () => {
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_IN_ERROR, error_code: 8 },
    ]);
    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: ROBOROCK_STATE_CHARGING, charge_status: 1, error_code: 0 },
    ]);

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_NONE,
    });
  });

  test("a B01/Q7 dps frame carrying only 120 reaches the tile", async () => {
    // dps 120 is error_code, and it was not among the 5 dps keys this plugin
    // read. On the local transport a fault is exactly the kind of thing that
    // arrives in a frame of its own.
    const { vacuum, matterUpdates } = liveHarness();

    await vacuum.notifyDeviceUpdater("LocalMessage", { dps: { 120: 7 } });

    expect(lastCluster(matterUpdates).operationalError).toEqual({
      errorStateId: RVC_ERROR_STUCK,
    });
  });
});
