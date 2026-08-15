"use strict";

// Matter's robot vacuum device type has no water-tank attribute of any kind.
// Two releases tried to say it through the fault attribute instead and both
// came back out — 1.4.61 and 3.4.1 — after four controlled tests on an S8 Pro
// Ultra with a genuinely empty tank produced no warning in Apple Home at all.
// So the tile is not a route, and a HAP contact sensor is the whole of it.
//
// What makes this sensor different from "docked" and "cleaning" is that the
// robots disagree about how they say it. Both of these were measured with the
// tank physically empty:
//
//   a70  S8 Pro Ultra  issue #5   dock_error_status 38, water_shortage_status 0
//   a75  Q Revo        issue #9   dock_error_status 38, water_shortage_status 1
//
// Wazza151 emptied and refilled his tank and watched dock_error_status track
// it; vp-debug12 confirmed his was empty while both fields were set. The a70's
// zero is the reason this is an OR and not a preference order — reading the
// shortage flag first and trusting its 0 would report a full tank on the very
// robot the condition was field-measured on.
//
// The tests enumerate the rule rather than those two rows: any field
// combination, any dock error code, and the resting state of every sensor in
// the registry rather than of this one.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const RoborockStateSensorAccessory =
  require("../src/state_sensor_accessory").default;
const {
  STATE_SENSOR_DEFINITIONS,
  getStateSensorDefinition,
} = require("../src/state_sensor_accessory");

const CONTACT_DETECTED = 0;
const CONTACT_NOT_DETECTED = 1;

const DOCK_ERROR_CLEAN_WATER_TANK_EMPTY = 38;

/**
 * A robot parked in its dock, doing nothing, with nothing wrong.
 *
 * The overwhelmingly common state at the moment Homebridge starts, which is
 * what makes it the right yardstick for a sensor's resting value.
 */
const AT_REST = { state: 8, charge_status: 1 };

/** Both display toggles, because both rewrite the published state. */
const TOGGLES = [
  { label: "both display toggles on", extended: true, chargingDocked: true },
  { label: "charging/docked off", extended: true, chargingDocked: false },
  { label: "extended states off", extended: false, chargingDocked: true },
  {
    label: "both display toggles off",
    extended: false,
    chargingDocked: false,
  },
];

function createVacuum({ extended = true, chargingDocked = true } = {}) {
  const status = {};
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableMatterExtendedOperationalStates: extended,
      enableMatterChargingDockedStates: chargingDocked,
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
        property === "name" ? "Vicky" : "sn-1",
      getProductAttribute: () => "roborock.vacuum.a75",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: false,
        canControlWater: true,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };

  const accessory = { UUID: "uuid-vacuum", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );

  return {
    async report(frame) {
      Object.assign(status, frame);
      await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
    },
    sensor: (key) => vacuum.getHomeKitStateSensorValue(key),
  };
}

describe("an empty tank is recognised however the robot says it", () => {
  const MEASURED = [
    {
      label: "an S8 Pro Ultra, which sets only the dock code (issue #5)",
      frame: { dock_error_status: 38, water_shortage_status: 0 },
      empty: true,
    },
    {
      label: "a Q Revo, which sets both (issue #9)",
      frame: { dock_error_status: 38, water_shortage_status: 1 },
      empty: true,
    },
    {
      label: "a robot with an onboard tank and no dock tank at all",
      frame: { dock_error_status: 0, water_shortage_status: 1 },
      empty: true,
    },
    {
      label: "the same S8 Pro Ultra after a refill",
      frame: { dock_error_status: 0, water_shortage_status: 0 },
      empty: false,
    },
  ];

  test.each(MEASURED.map((row) => [row.label, row]))(
    "%s",
    async (_label, row) => {
      const vacuum = createVacuum();
      await vacuum.report({ ...AT_REST, ...row.frame });

      expect(vacuum.sensor("waterTankEmpty")).toBe(row.empty);
    }
  );

  test("only 38 means an empty clean-water tank", async () => {
    // dock_error_status carries the dock's whole family of housekeeping
    // faults. Treating "non-zero" as empty would report a full waste-water
    // tank, a missing dust bag or a blocked duct as a dry robot — and the
    // sensor exists precisely so somebody can be told to go and fill it.
    for (const code of [1, 2, 10, 34, 37, 39, 40, 60, 254]) {
      const vacuum = createVacuum();
      await vacuum.report({
        ...AT_REST,
        dock_error_status: code,
        water_shortage_status: 0,
      });

      expect(vacuum.sensor("waterTankEmpty")).toBe(false);
    }

    const empty = createVacuum();
    await empty.report({
      ...AT_REST,
      dock_error_status: DOCK_ERROR_CLEAN_WATER_TANK_EMPTY,
      water_shortage_status: 0,
    });
    expect(empty.sensor("waterTankEmpty")).toBe(true);
  });

  test("a robot that reports neither field claims nothing", async () => {
    // Null, not false. An absent field is the robot declining to answer, and
    // answering "full" on its behalf would invent the one reading a user would
    // act on — they would stop checking the tank because the Home app said it
    // was fine.
    const vacuum = createVacuum();
    await vacuum.report(AT_REST);

    expect(vacuum.sensor("waterTankEmpty")).toBeNull();
  });

  test("nothing is claimed before the robot has reported at all", async () => {
    // Same rule as the other two sensors: state 0 with no charge status is a
    // robot that has not started talking yet, measured at up to 27 seconds on
    // a Q7. A sensor that answered here would move when the real value landed.
    const vacuum = createVacuum();
    await vacuum.report({
      state: 0,
      charge_status: 0,
      dock_error_status: 38,
    });

    expect(vacuum.sensor("waterTankEmpty")).toBeNull();
  });

  test.each(TOGGLES.map((toggle) => [toggle.label, toggle]))(
    "reads the same with %s",
    async (_label, toggle) => {
      // The fault form this file has been bitten by seven times: a rule built
      // on the controller-facing state works only for users who ticked an
      // unrelated display box. Neither toggle touches the tank.
      const vacuum = createVacuum(toggle);
      await vacuum.report({ ...AT_REST, dock_error_status: 38 });

      expect(vacuum.sensor("waterTankEmpty")).toBe(true);
    }
  );
});

describe("a sensor at rest is not announcing anything", () => {
  function createSensor(definition) {
    const characteristics = new Map();
    const service = {
      setCharacteristic: jest.fn(() => service),
      updateCharacteristic: jest.fn((type, value) => {
        characteristics.set(type, value);
        return service;
      }),
      getCharacteristic: jest.fn(() => ({
        removeAllListeners: jest.fn(),
        onGet: jest.fn(function (handler) {
          service.getHandler = handler;
          return this;
        }),
      })),
    };
    const information = { setCharacteristic: jest.fn(() => information) };

    const accessory = {
      displayName: `Vicky ${definition.nameSuffix}`,
      UUID: "uuid-sensor",
      // No lastValue: a fresh install, or a sensor just switched on.
      context: {},
      getService: jest.fn((type) =>
        type === "ContactSensor" ? service : information
      ),
      addService: jest.fn(() => service),
    };

    const platform = {
      Service: {
        AccessoryInformation: "Information",
        ContactSensor: "ContactSensor",
      },
      Characteristic: {
        Manufacturer: "Manufacturer",
        Model: "Model",
        SerialNumber: "SerialNumber",
        Name: "Name",
        ContactSensorState: "ContactSensorState",
      },
      getVacuumModel: () => "roborock.vacuum.a75",
      getVacuumSerialNumber: () => "sn-1",
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };

    const sensor = new RoborockStateSensorAccessory(
      platform,
      accessory,
      definition,
      "device-1"
    );

    return { sensor, service, characteristics };
  }

  test("a resting robot reports exactly what every sensor rests on", async () => {
    // The general form of the bug. Before 3.10.0 every sensor answered Closed
    // with no cached reading, so a fresh "Cleaning" sensor announced a
    // finished cleaning the moment a robot sitting in its dock first said it
    // was idle — and a fresh "Water Tank Empty" would have announced an empty
    // tank on every install.
    //
    // The rule is the yardstick, not the two cases: whatever a robot at rest
    // reports, that is what the sensor must already be showing.
    const vacuum = createVacuum();
    await vacuum.report({
      ...AT_REST,
      dock_error_status: 0,
      water_shortage_status: 0,
    });

    for (const definition of STATE_SENSOR_DEFINITIONS) {
      expect({
        sensor: definition.key,
        resting: definition.restingState,
      }).toEqual({
        sensor: definition.key,
        resting: vacuum.sensor(definition.key),
      });
    }
  });

  test("the characteristic answers a read with that resting state", () => {
    // The declaration is only worth having if the read honours it — the
    // accessory has to answer before any robot data exists, and that answer is
    // what an automation compares its next reading against.
    for (const definition of STATE_SENSOR_DEFINITIONS) {
      const { characteristics, service } = createSensor(definition);
      const expected = definition.restingState
        ? CONTACT_DETECTED
        : CONTACT_NOT_DETECTED;

      expect(characteristics.get("ContactSensorState")).toBe(expected);
      expect(service.getHandler()).toBe(expected);
    }
  });

  test("Water Tank Empty specifically rests Open", () => {
    // Named as well as enumerated, because this is the one where resting
    // Closed sends a push notification about a tank nobody has looked at.
    const definition = getStateSensorDefinition("waterTankEmpty");
    const { characteristics } = createSensor(definition);

    expect(definition.restingState).toBe(false);
    expect(characteristics.get("ContactSensorState")).toBe(
      CONTACT_NOT_DETECTED
    );
  });

  test("a cached reading still wins over the resting state", () => {
    // The resting state is for having nothing, not for overriding something.
    // A restart must not move a sensor that already knew its answer.
    const definition = getStateSensorDefinition("waterTankEmpty");
    const characteristics = new Map();
    const service = {
      setCharacteristic: jest.fn(() => service),
      updateCharacteristic: jest.fn((type, value) => {
        characteristics.set(type, value);
        return service;
      }),
      getCharacteristic: jest.fn(() => ({
        removeAllListeners: jest.fn(),
        onGet: jest.fn(function () {
          return this;
        }),
      })),
    };
    const information = { setCharacteristic: jest.fn(() => information) };

    new RoborockStateSensorAccessory(
      {
        Service: {
          AccessoryInformation: "Information",
          ContactSensor: "ContactSensor",
        },
        Characteristic: {
          Manufacturer: "Manufacturer",
          Model: "Model",
          SerialNumber: "SerialNumber",
          Name: "Name",
          ContactSensorState: "ContactSensorState",
        },
        getVacuumModel: () => "roborock.vacuum.a75",
        getVacuumSerialNumber: () => "sn-1",
        log: { debug: jest.fn() },
      },
      {
        displayName: "Vicky Water Tank Empty",
        UUID: "uuid-sensor",
        context: { lastValue: true },
        getService: jest.fn((type) =>
          type === "ContactSensor" ? service : information
        ),
        addService: jest.fn(() => service),
      },
      definition,
      "device-1"
    );

    expect(characteristics.get("ContactSensorState")).toBe(CONTACT_DETECTED);
  });
});
