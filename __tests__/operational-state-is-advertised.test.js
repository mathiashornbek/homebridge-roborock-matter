const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

// Matter requires the OperationalState attribute to be a member of
// OperationalStateList. When it is not, Apple Home does not fall back to
// anything sensible — the tile parks itself in "Updating" and never leaves,
// which is what issue #7 reported and what the missing dock activities caused
// before 3.3.x. Two separate releases fixed one offending value each
// (SEEKING_CHARGER, then CHARGING/DOCKED) by looking at the lines in front of
// them. This test states the rule instead of the cases: whatever combination
// of toggles and robot status the plugin is handed, it must never publish a
// state it has not advertised.

function createPlatform(status, config) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterServiceArea: true,
      enableMatterPowerSource: true,
      enableMatterCleanMode: true,
      preferCloudForMatterCommands: false,
      ...config,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn().mockResolvedValue(undefined),
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
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
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
  };
}

function buildOperationalStateCluster(status, config) {
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  new RoborockMatterVacuumAccessory(
    createPlatform(status, config),
    accessory,
    { duid: "device-1" },
    true
  );

  return accessory.clusters.rvcOperationalState;
}

// Every Roborock state code the plugin's switch names, plus codes it does not
// know (gaps in the table, a future firmware value, and a garbage reading) so
// the default branch is covered too.
const ROBOROCK_STATES = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  15,
  16,
  17,
  18,
  19,
  22,
  23,
  25,
  26,
  28,
  29,
  30,
  100,
  255,
  "",
  null,
];

const CHARGE_STATUSES = [0, 1];

// null exercises the "no battery reading" path in the Charging/Docked split;
// 15 and 100 sit on either side of the default charged threshold.
const BATTERIES = [null, 15, 100];

const TOGGLE_COMBINATIONS = [false, true].flatMap((extended) =>
  [false, true].flatMap((chargingDocked) =>
    [false, true].map((faultReporting) => ({
      enableMatterExtendedOperationalStates: extended,
      enableMatterChargingDockedStates: chargingDocked,
      enableMatterFaultReporting: faultReporting,
    }))
  )
);

describe("published operationalState is always advertised", () => {
  test("no combination of toggles and robot status publishes an unadvertised state", () => {
    const violations = [];

    for (const config of TOGGLE_COMBINATIONS) {
      for (const state of ROBOROCK_STATES) {
        for (const chargeStatus of CHARGE_STATUSES) {
          for (const battery of BATTERIES) {
            const status = { state, charge_status: chargeStatus };
            if (battery !== null) {
              status.battery = battery;
            }

            const cluster = buildOperationalStateCluster(status, config);
            const advertised = cluster.operationalStateList.map(
              (entry) => entry.operationalStateId
            );

            if (!advertised.includes(cluster.operationalState)) {
              violations.push(
                `state=${state} charge_status=${chargeStatus} ` +
                  `battery=${battery} extended=${config.enableMatterExtendedOperationalStates} ` +
                  `chargingDocked=${config.enableMatterChargingDockedStates} ` +
                  `faults=${config.enableMatterFaultReporting} ` +
                  `published=${cluster.operationalState} advertised=[${advertised}]`
              );
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  }, 60000);

  test("the advertised list never carries labels and never repeats an id", () => {
    for (const config of TOGGLE_COMBINATIONS) {
      const cluster = buildOperationalStateCluster(
        { state: 8, charge_status: 1, battery: 90 },
        config
      );
      const ids = cluster.operationalStateList.map(
        (entry) => entry.operationalStateId
      );

      // Apple Home sticks on "Connecting" when entries carry labels, and a
      // duplicated id is a malformed list even though it would satisfy the
      // membership rule above.
      for (const entry of cluster.operationalStateList) {
        expect(entry).not.toHaveProperty("operationalStateLabel");
        expect(typeof entry.operationalStateId).toBe("number");
      }
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
