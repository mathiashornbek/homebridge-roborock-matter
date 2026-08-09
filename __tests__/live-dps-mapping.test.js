"use strict";

// The Roborock v1 dps push numbering is 120 error_code, 121 state,
// 122 battery, 123 fan_power, 124 water_box_mode, 125/126/127 the brush and
// filter lives, 133 charge_status. This repository's own consumables table
// uses 125/126/127 for exactly those lives, which corroborates the numbering.
//
// 123 used to be read as charge_status. A suction change mid-clean — from the
// Roborock app, a schedule, or SmartPlan picking a level itself — pushes a
// frame whose only field is 123, so the plugin saw {charge_status: 102} with
// no state and fell through to the charging branch. An actively cleaning
// robot then showed as Charging in Apple Home.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RVC_OPERATIONAL_STATE_RUNNING = 1;
const RVC_OPERATIONAL_STATE_CHARGING = 65;

function createPlatform({ status = {}, matterUpdates = [] } = {}) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterPowerSource: true,
      enableMatterChargingDockedStates: true,
      chargedBatteryThreshold: 90,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn(async (uuid, cluster, attributes) => {
        matterUpdates.push({ cluster, attributes });
      }),
    }),
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

function createAccessory(platform) {
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { accessory, vacuum };
}

/** The last operationalState value actually published to Matter. */
function lastOperationalState(matterUpdates) {
  for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
    const update = matterUpdates[i];
    if (
      update.cluster === "rvcOperationalState" &&
      update.attributes &&
      "operationalState" in update.attributes
    ) {
      return update.attributes.operationalState;
    }
  }
  return undefined;
}

function lastBattery(matterUpdates) {
  for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
    const update = matterUpdates[i];
    if (
      update.cluster === "powerSource" &&
      update.attributes &&
      "batPercentRemaining" in update.attributes
    ) {
      return update.attributes.batPercentRemaining;
    }
  }
  return undefined;
}

describe("dps field numbering", () => {
  test("a suction change while cleaning does not flip the robot to Charging", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: 5, battery: 60 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    // Robot is cleaning; the user switches suction to Balanced (102).
    await vacuum.notifyDeviceUpdater("LocalMessage", { dps: { 123: 102 } });

    expect(lastOperationalState(matterUpdates)).not.toBe(
      RVC_OPERATIONAL_STATE_CHARGING
    );
    expect(lastOperationalState(matterUpdates)).toBe(
      RVC_OPERATIONAL_STATE_RUNNING
    );
  });

  test("dps 133 is what actually reports charge status", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: 8, battery: 50 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await vacuum.notifyDeviceUpdater("LocalMessage", { dps: { 133: 1 } });

    expect(lastOperationalState(matterUpdates)).toBe(
      RVC_OPERATIONAL_STATE_CHARGING
    );
  });

  test("state and battery keep their established meanings", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: 5, battery: 60 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);

    await vacuum.notifyDeviceUpdater("LocalMessage", {
      dps: { 121: 8, 122: 41 },
    });

    // 121 = state (8 = charging), 122 = battery (half-percent on the wire).
    expect(lastBattery(matterUpdates)).toBe(41 * 2);
    expect(lastOperationalState(matterUpdates)).toBe(
      RVC_OPERATIONAL_STATE_CHARGING
    );
  });
});
