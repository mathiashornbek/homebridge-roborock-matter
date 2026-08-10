"use strict";

// Apple Home has always shown a stuck robot as "Ready", because
// toControllerOperationalState rewrote ERROR to STOPPED — a downgrade that was
// never needed, since ERROR (3) is a member of even the basic advertised
// operational state list. That is what this feature fixes, and all it fixes.
//
// It started out larger. 3.3.0 also published the Matter fault attribute
// (`operationalError`) so Apple Home could say WHY, which is what Wazza151
// asked for in issue #5. Three controlled tests on his S8 Pro Ultra with an
// empty clean water tank killed that idea: Apple drew no warning with the
// fault sent beside a Charging state, drew no warning with it sent beside a
// forced Error state either, and the tile went to a stuck "Updating..." that
// needed a manual poke. Apple does not appear to render RVC OperationalError
// from a bridged accessory at all — the same reason 1.4.61 removed the
// original write. So the attribute is gone again, and these tests pin that it
// stays gone.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RVC_OPERATIONAL_STATE_STOPPED = 0;
const RVC_OPERATIONAL_STATE_ERROR = 3;

const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_IN_ERROR = 12;

function createPlatform({
  status = {},
  matterUpdates = [],
  enableMatterFaultReporting = true,
} = {}) {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const publish = jest.fn(async (uuid, cluster, attributes) => {
    matterUpdates.push({ cluster, attributes });
  });

  return {
    log,
    publish,
    platformConfig: {
      enableMatter: true,
      enableMatterPowerSource: true,
      enableMatterFaultReporting,
    },
    getMatterApi: () => ({ updateAccessoryState: publish }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Test Vacuum" : "",
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

function createAccessory(platform, isRegistered = true) {
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    isRegistered
  );
  return { accessory, vacuum };
}

function lastOperationalStateCluster(matterUpdates) {
  for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
    if (matterUpdates[i].cluster === "rvcOperationalState") {
      return matterUpdates[i].attributes;
    }
  }
  return undefined;
}

async function publishSnapshot(vacuum) {
  await vacuum.updateMatterStateFromRoborock("test");
}

describe("a halted robot stops claiming it is Ready", () => {
  test("a robot that reports it has halted is published as Error", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 8, battery: 42 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    expect(lastOperationalStateCluster(matterUpdates).operationalState).toBe(
      RVC_OPERATIONAL_STATE_ERROR
    );
  });

  test("with the setting off, the old Ready behaviour is untouched", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 8, battery: 42 },
      matterUpdates,
      enableMatterFaultReporting: false,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    expect(lastOperationalStateCluster(matterUpdates).operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
  });
});

describe("the Matter fault attribute is never published (field-proven)", () => {
  test.each([
    [
      "a halted robot",
      { state: ROBOROCK_STATE_IN_ERROR, error_code: 8, battery: 42 },
    ],
    [
      "a charging robot with an empty clean water tank",
      {
        state: ROBOROCK_STATE_CHARGING,
        error_code: 0,
        dock_error_status: 38,
        battery: 100,
      },
    ],
    [
      "a charging robot with a full waste water tank",
      { state: ROBOROCK_STATE_CHARGING, dock_error_status: 39, battery: 100 },
    ],
    [
      "a robot whose onboard tank ran dry mid-mop",
      { state: 5, water_shortage_status: 1, battery: 70 },
    ],
  ])("%s publishes no operationalError", async (_label, status) => {
    const matterUpdates = [];
    const platform = createPlatform({ status, matterUpdates });
    const { accessory, vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    // Absent, in the registration snapshot and in every runtime publish.
    // Apple never drew it, and sending it wedged the tile.
    expect(accessory.clusters.rvcOperationalState).not.toHaveProperty(
      "operationalError"
    );
    for (const update of matterUpdates) {
      if (update.cluster === "rvcOperationalState") {
        expect(update.attributes).not.toHaveProperty("operationalError");
      }
    }
  });

  test("a dock condition never makes a working robot look unstartable", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: {
        state: ROBOROCK_STATE_CHARGING,
        error_code: 0,
        dock_error_status: 38,
        battery: 100,
      },
      matterUpdates,
    });
    // The 3.4.0 escalation switch is gone; a stale config key must not
    // resurrect the behaviour for anyone who still has it in config.json.
    platform.platformConfig.enableMatterDockFaultsAsError = true;
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster.operationalState).not.toBe(RVC_OPERATIONAL_STATE_ERROR);
    expect(cluster).not.toHaveProperty("operationalError");
  });
});
