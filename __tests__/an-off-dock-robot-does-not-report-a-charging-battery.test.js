"use strict";

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const vacuums = [];
afterEach(() => {
  for (const vacuum of vacuums.splice(0)) vacuum.dispose();
});

function createRobot(status) {
  const published = {};
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterPowerSource: true,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: async (_uuid, cluster, attributes) => {
        published[cluster] = { ...published[cluster], ...attributes };
      },
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (_duid, property) =>
        property === "name" ? "Uptown Rock" : "",
      getProductAttribute: () => "roborock.vacuum.a27",
      getVacuumDeviceStatus: (_duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  vacuums.push(vacuum);
  return { accessory, vacuum, published };
}

test("the captured sleeping S7 MaxV status publishes NotCharging and keeps its battery and tank warning", async () => {
  const status = {
    state: 2,
    battery: 98,
    error_code: 0,
    water_shortage_status: 1,
    dock_error_status: 38,
    charge_status: 1,
  };
  const { accessory, vacuum, published } = createRobot(status);

  expect(accessory.clusters.powerSource).toMatchObject({
    batPercentRemaining: 196,
    batChargeState: 3,
    batTimeToFullCharge: null,
  });
  await vacuum.notifyDeviceUpdater("LocalMessage", [status]);
  expect(published.powerSource).toMatchObject({
    batPercentRemaining: 196,
    batChargeState: 3,
    batTimeToFullCharge: null,
  });
  expect(published.rvcOperationalState.operationalError).toMatchObject({
    errorStateId: 68,
  });
});

test.each([2, 3, 4, 5, 6, 7, 10, 11, 15, 16, 17, 18, 26, 29, 6301, 6309, 6310])(
  "known off-dock state %i overrides a nonzero charge flag, including at 100%%",
  (state) => {
    for (const battery of [98, 100]) {
      const { accessory } = createRobot({
        state,
        battery,
        charge_status: 1,
      });
      expect(accessory.clusters.powerSource).toMatchObject({
        batPercentRemaining: battery * 2,
        batChargeState: 3,
        batTimeToFullCharge: null,
      });
    }
  }
);

test("state-only pushes clear a retained charge flag and resume charging after docking", async () => {
  const { vacuum, published } = createRobot({
    state: 100,
    battery: 100,
    charge_status: 1,
  });

  await vacuum.notifyDeviceUpdater("CloudMessage", { dps: { 121: 2 } });
  expect(published.powerSource).toMatchObject({
    batPercentRemaining: 200,
    batChargeState: 3,
    batTimeToFullCharge: null,
  });

  await vacuum.notifyDeviceUpdater("LocalMessage", [{ battery: 98 }]);
  expect(published.powerSource).toMatchObject({
    batPercentRemaining: 196,
    batChargeState: 3,
    batTimeToFullCharge: null,
  });

  await vacuum.notifyDeviceUpdater("LocalMessage", [{ state: 8 }]);
  expect(published.powerSource).toMatchObject({
    batChargeState: 1,
    batTimeToFullCharge: 360,
  });

  await vacuum.notifyDeviceUpdater("CloudMessage", {
    dps: { 121: 100, 122: 100 },
  });
  expect(published.powerSource).toMatchObject({
    batPercentRemaining: 200,
    batChargeState: 2,
    batTimeToFullCharge: 0,
  });
});

test.each([
  ["charging", { state: 8, battery: 98, charge_status: 1 }, 1],
  ["fully charged", { state: 100, battery: 100, charge_status: 1 }, 2],
  ["charging complete", { state: 8, battery: 100, charge_status: 1 }, 2],
  ["waiting to charge", { state: 8, battery: 98, charge_status: 0 }, 3],
  ["emptying dust", { state: 22, battery: 98, charge_status: 1 }, 1],
  ["washing the mop", { state: 23, battery: 98, charge_status: 1 }, 1],
  ["missing charge flag", { state: 8, battery: 98 }, 1],
  ["missing state", { battery: 98, charge_status: 1 }, 1],
  ["unknown state", { state: 999, battery: 98, charge_status: 1 }, 1],
  ["missing state and charge flag", { battery: 98 }, 0],
  ["missing battery", { state: 2, charge_status: 1 }, 0],
])("preserves existing battery reporting when %s", (_label, status, expected) => {
  const { accessory } = createRobot(status);
  expect(accessory.clusters.powerSource.batChargeState).toBe(expected);
});
