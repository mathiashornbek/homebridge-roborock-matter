"use strict";

// Two things met here. Apple Home has always shown a stuck robot as "Ready",
// because toControllerOperationalState rewrote ERROR to STOPPED — a downgrade
// that was never needed, since ERROR (3) is a member of even the basic
// advertised operational state list. And Wazza151 (issue #5) asked for the
// indicator his previous Matter bridge showed when the clean water tank ran
// empty or the waste water tank filled up.
//
// Both are the same missing piece: RVC Operational State's OperationalError
// attribute, which 1.4.61 removed for Apple Home commissioning safety. It
// comes back opt-in, and with a runtime escape hatch, because operationalError
// shares a cluster payload with operationalState — a rejected write would
// otherwise take the whole tile down with it.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RVC_OPERATIONAL_STATE_STOPPED = 0;
const RVC_OPERATIONAL_STATE_ERROR = 3;

const ERROR_STATE_NO_ERROR = 0x00;
const ERROR_STATE_UNABLE_TO_COMPLETE = 0x02;
const ERROR_STATE_STUCK = 0x41;
const ERROR_STATE_DUST_BIN_FULL = 0x43;
const ERROR_STATE_WATER_TANK_EMPTY = 0x44;

const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_IN_ERROR = 12;

function createPlatform({
  status = {},
  matterUpdates = [],
  enableMatterFaultReporting = true,
  updateAccessoryState,
} = {}) {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const publish =
    updateAccessoryState ??
    jest.fn(async (uuid, cluster, attributes) => {
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
      // The real accessor reads the plugin's own error code table.
      getErrorCodeDescription: (errorCode) =>
        ({ 8: "Device stuck", 254: "Bin full" })[errorCode] ?? "",
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

/** Publish a snapshot without depending on any particular live-message shape. */
async function publishSnapshot(vacuum) {
  await vacuum.updateMatterStateFromRoborock("test");
}

describe("the robot's own faults reach the Apple Home tile", () => {
  test("a robot that reports it has halted is published as Error, not Ready", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 8, battery: 42 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster.operationalState).toBe(RVC_OPERATIONAL_STATE_ERROR);
    expect(cluster.operationalError).toEqual({
      errorStateId: ERROR_STATE_STUCK,
      errorStateDetails: "Device stuck",
    });
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

    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster.operationalState).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    // Not merely NoError — absent. The attribute must not appear in a payload
    // at all for users who have not opted in, which is what keeps
    // commissioning identical to 3.2.0 for everyone else.
    expect(cluster).not.toHaveProperty("operationalError");
  });

  test("an error state with no code still names something truthful", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 0, battery: 42 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster.operationalState).toBe(RVC_OPERATIONAL_STATE_ERROR);
    // "Error, but no error" is a contradiction a controller should never be
    // handed.
    expect(cluster.operationalError.errorStateId).toBe(
      ERROR_STATE_UNABLE_TO_COMPLETE
    );
  });

  test("an unrecognised Roborock code degrades to a vague truth, not a wrong specific", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 9999 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster.operationalError.errorStateId).toBe(
      ERROR_STATE_UNABLE_TO_COMPLETE
    );
    expect(cluster.operationalError.errorStateDetails).toBe(
      "Roborock error 9999"
    );
  });
});

describe("dock conditions (issue #5)", () => {
  test("an empty clean water tank is reported without making the robot look broken", async () => {
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
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster.operationalError).toEqual({
      errorStateId: ERROR_STATE_WATER_TANK_EMPTY,
      errorStateDetails: "Clean water tank empty",
    });
    // The robot can still vacuum, and a controller may refuse Start to an
    // accessory in Error — so a dock consumable must not seize the tile.
    expect(cluster.operationalState).not.toBe(RVC_OPERATIONAL_STATE_ERROR);
  });

  test("a full waste water tank is reported as a container needing emptying", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: {
        state: ROBOROCK_STATE_CHARGING,
        dock_error_status: 39,
        battery: 100,
      },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    const cluster = lastOperationalStateCluster(matterUpdates);
    // Matter had no dirty-water-tank code before 1.4; the nearest thing every
    // controller understands is "a container is full", with the real wording
    // carried in the details.
    expect(cluster.operationalError.errorStateId).toBe(
      ERROR_STATE_DUST_BIN_FULL
    );
    expect(cluster.operationalError.errorStateDetails).toBe(
      "Waste water tank full"
    );
  });

  test("the robot's own fault outranks a dock consumable", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: {
        state: ROBOROCK_STATE_IN_ERROR,
        error_code: 8,
        dock_error_status: 38,
      },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    // Stuck under the sofa is what the user needs to hear first.
    expect(
      lastOperationalStateCluster(matterUpdates).operationalError.errorStateId
    ).toBe(ERROR_STATE_STUCK);
  });

  test("a detached tank and mop pad on a dry run are not faults", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: {
        state: ROBOROCK_STATE_CHARGING,
        error_code: 0,
        dock_error_status: 0,
        // Normal and correct for a vacuum-only run. Reporting these would put
        // a permanent warning on every dry robot's tile.
        water_box_status: 0,
        water_box_carriage_status: 0,
        water_shortage_status: 0,
        battery: 100,
      },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    expect(lastOperationalStateCluster(matterUpdates).operationalError).toEqual(
      { errorStateId: ERROR_STATE_NO_ERROR }
    );
  });

  test("an onboard tank that ran dry mid-mop is a fault", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: 5, water_shortage_status: 1, battery: 70 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    expect(
      lastOperationalStateCluster(matterUpdates).operationalError.errorStateId
    ).toBe(ERROR_STATE_WATER_TANK_EMPTY);
  });
});

describe("the fault attribute is safe to publish", () => {
  test("a cleared fault is published as NoError, not dropped", async () => {
    const matterUpdates = [];
    const status = {
      state: ROBOROCK_STATE_CHARGING,
      dock_error_status: 38,
      battery: 100,
    };
    const platform = createPlatform({ status, matterUpdates });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);
    expect(
      lastOperationalStateCluster(matterUpdates).operationalError.errorStateId
    ).toBe(ERROR_STATE_WATER_TANK_EMPTY);

    // The user refills the tank. An attribute that is simply omitted leaves
    // the controller showing the stale fault forever.
    status.dock_error_status = 0;
    await publishSnapshot(vacuum);

    expect(
      lastOperationalStateCluster(matterUpdates).operationalError.errorStateId
    ).toBe(ERROR_STATE_NO_ERROR);
  });

  test("the error struct never carries a label", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 8 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    // The spec reserves errorStateLabel for manufacturer-range IDs, and a
    // label on a standard ID is exactly what wedged Apple Home at
    // "Connecting" in 1.4.40. errorStateDetails is the field that may carry
    // free text alongside a standard ID.
    expect(
      lastOperationalStateCluster(matterUpdates).operationalError
    ).not.toHaveProperty("errorStateLabel");
  });

  test("a rejected fault write costs the fault, never the tile", async () => {
    const matterUpdates = [];
    const publish = jest.fn(async (uuid, cluster, attributes) => {
      if (attributes && "operationalError" in attributes) {
        throw new Error("Unsupported attribute operationalError");
      }
      matterUpdates.push({ cluster, attributes });
    });
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 8, battery: 30 },
      matterUpdates,
      updateAccessoryState: publish,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);

    // The operational state still landed — without this the tile would
    // freeze on whatever it last showed for as long as the setting is on.
    const cluster = lastOperationalStateCluster(matterUpdates);
    expect(cluster).toBeDefined();
    expect(cluster.operationalState).toBe(RVC_OPERATIONAL_STATE_ERROR);
    expect(cluster).not.toHaveProperty("operationalError");
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("operationalError")
    );

    // And it latches: the next snapshot does not try again, so the failure
    // costs one write rather than one write per poll forever.
    const attemptsBefore = publish.mock.calls.length;
    await publishSnapshot(vacuum);
    const retriedWithError = publish.mock.calls
      .slice(attemptsBefore)
      .some(
        ([, , attributes]) => attributes && "operationalError" in attributes
      );
    expect(retriedWithError).toBe(false);
  });

  test("an endpoint that is merely still starting up does not disable the feature", async () => {
    const matterUpdates = [];
    let failNext = true;
    const publish = jest.fn(async (uuid, cluster, attributes) => {
      if (cluster === "rvcOperationalState" && failNext) {
        failNext = false;
        throw new Error("Endpoint is still initializing");
      }
      matterUpdates.push({ cluster, attributes });
    });
    const platform = createPlatform({
      status: { state: ROBOROCK_STATE_IN_ERROR, error_code: 8 },
      matterUpdates,
      updateAccessoryState: publish,
    });
    const { vacuum } = createAccessory(platform);

    await publishSnapshot(vacuum);
    await publishSnapshot(vacuum);

    // Turning an opt-in feature off for the session because an endpoint was
    // half a second from ready would be a bug in its own right.
    expect(lastOperationalStateCluster(matterUpdates)).toHaveProperty(
      "operationalError"
    );
    expect(platform.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("operationalError")
    );
  });
});
