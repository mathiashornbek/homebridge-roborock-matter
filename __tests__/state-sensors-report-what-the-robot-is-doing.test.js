"use strict";

// Apple Home will not accept a Matter vacuum as an automation TRIGGER. pponce
// measured that in issue #3 and confirmed it a second time after the action
// switches shipped: the switches are commands an automation *sends*, and
// nothing the robot does can *start* one. A contact sensor is a trigger source
// in every Home client, so mirroring the robot's state onto one is the only way
// this works at all.
//
// Two states ship, in the order he ranked them when asked which he would
// actually trigger on: docked first ("I'd use the docked feature on its own for
// sure"), cleaning second. He also named the pair he wants them for — "it might
// be good to know if the robot is not docked and not actively cleaning. Means
// it might be stuck somewhere" — which is why both ship together, and why the
// stuck case has a test of its own below.
//
// Three rules carry all the risk in this feature, and each is enumerated over
// the whole class rather than over the case that prompted it:
//
//  1. The value comes from the ROBOT'S OWN state, never from the state the
//     controller was told. Two unrelated display toggles rewrite the published
//     operational state — CHARGING/DOCKED become STOPPED without
//     enableMatterChargingDockedStates, and the dock chores become RUNNING
//     without enableMatterExtendedOperationalStates — so a sensor built on the
//     published value would have worked only for users who had ticked a box
//     about something else. That is the same fault form as issue #9's fix and
//     issue #5's: the rule made one level below the thing that decides.
//
//  2. Nothing is claimed before the robot has reported. A sensor that filled
//     the startup gap with a guess would MOVE when real data arrived, and
//     moving is precisely what an automation triggers on. A Q7 on the
//     maintainer's own account has been measured reporting no usable state for
//     27 seconds after every restart, on fourteen separate runs.
//
//  3. Every HAP accessory kind survives every sweep. discoverDevices() deletes
//     cached HAP accessories it does not recognise, and each kind's own sync
//     deletes accessories its config no longer asks for. A sensor is invisible
//     to the switch rules and vice versa, so both directions are asserted.

const RoborockPlatform = require("../src/platform").default;
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const RoborockStateSensorAccessory =
  require("../src/state_sensor_accessory").default;
const {
  STATE_SENSOR_DEFINITIONS,
  STATE_SENSOR_KIND,
  stateSensorUuidSeed,
} = require("../src/state_sensor_accessory");
const {
  ACTION_SWITCH_KIND,
  actionSwitchUuidSeed,
} = require("../src/action_switch_accessory");
const { HOMEKIT_STATE_SENSOR_KEYS } = require("../src/types");

const RUN_MODE_CLEANING = 1;
const CONTACT_DETECTED = 0;
const CONTACT_NOT_DETECTED = 1;

/** Both display toggles, in every combination, because both rewrite state. */
const TOGGLES = [
  { label: "both display toggles on", extended: true, chargingDocked: true },
  {
    label: "charging/docked off",
    extended: true,
    chargingDocked: false,
  },
  {
    label: "extended states off",
    extended: false,
    chargingDocked: true,
  },
  {
    label: "both display toggles off",
    extended: false,
    chargingDocked: false,
  },
];

/**
 * What the robot is doing, as it reports it, with what the sensors must say.
 *
 * `docked` is asserted as a fixed truth here because it must be the same in
 * every toggle combination — that is the whole point of rule 1. `cleaning` is
 * NOT in this table: it is checked against the run mode that actually reached
 * Matter instead, so the test pins "the sensor and the tile agree" rather than a
 * hand-copied second opinion about what the tile should say.
 */
const ROBOT_STATES = [
  { label: "charging in its dock", state: 8, charge_status: 1, docked: true },
  {
    label: "fully charged in its dock",
    state: 100,
    charge_status: 0,
    docked: true,
  },
  { label: "cleaning", state: 5, charge_status: 0, docked: false },
  { label: "paused mid-run", state: 10, charge_status: 0, docked: false },
  { label: "returning to the dock", state: 6, charge_status: 0, docked: false },
  {
    label: "idle away from the dock",
    state: 3,
    charge_status: 0,
    docked: false,
  },
  { label: "halted with an error", state: 12, charge_status: 0, docked: false },
  {
    label: "emptying its bin in the dock",
    state: 22,
    charge_status: 1,
    docked: true,
  },
  {
    label: "washing the mop in the dock",
    state: 23,
    charge_status: 1,
    docked: true,
  },
];

function createVacuumPlatform({ status, extended, chargingDocked, published }) {
  return {
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
      updateAccessoryState: jest.fn(async (_uuid, cluster, attributes) => {
        // What actually reached Matter. accessory.clusters is only the snapshot
        // taken at registration and never moves again, so reading it would have
        // compared the sensor against the robot's state on startup — the first
        // draft did, and every mid-run assertion failed for that reason rather
        // than for the reason it was written to catch.
        if (attributes && cluster in published && attributes) {
          Object.assign(published[cluster], attributes);
        }
      }),
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
}

/** A registered vacuum plus the live snapshot object it reads through. */
function createVacuum({ extended, chargingDocked, initialStatus = {} }) {
  const status = { ...initialStatus };
  const published = { rvcRunMode: {}, rvcOperationalState: {} };
  const platform = createVacuumPlatform({
    status,
    extended,
    chargingDocked,
    published,
  });
  const accessory = { UUID: "uuid-vacuum", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );

  // Seed from the registration snapshot so a sensor read before any live frame
  // still has something to compare against.
  Object.assign(published.rvcRunMode, accessory.clusters.rvcRunMode);
  Object.assign(
    published.rvcOperationalState,
    accessory.clusters.rvcOperationalState
  );

  return {
    accessory,
    platform,
    async report(frame) {
      Object.assign(status, frame);
      await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
    },
    sensor: (key) => vacuum.getHomeKitStateSensorValue(key),
    publishedRunMode: () => published.rvcRunMode.currentMode,
    publishedOperationalState: () =>
      published.rvcOperationalState.operationalState,
  };
}

describe("the Docked sensor reads the robot, not what the controller was told", () => {
  const cases = TOGGLES.flatMap((toggle) =>
    ROBOT_STATES.map((robotState) => [
      robotState.label,
      toggle.label,
      toggle,
      robotState,
    ])
  );

  test.each(cases)(
    "a robot %s reads the same with %s",
    async (_stateLabel, _toggleLabel, toggle, robotState) => {
      const vacuum = createVacuum(toggle);
      await vacuum.report({
        state: robotState.state,
        charge_status: robotState.charge_status,
      });

      expect(vacuum.sensor("docked")).toBe(robotState.docked);
    }
  );

  test("the published operational state genuinely disagrees, so this is not a free pass", async () => {
    // Without this, every assertion above could be satisfied by a sensor that
    // read the published operational state — the wrong implementation — and the
    // suite would be green. A robot charging in its dock is published as
    // STOPPED (0) while enableMatterChargingDockedStates is off, which is
    // indistinguishable from a robot standing idle in the middle of the floor.
    const off = createVacuum({ extended: true, chargingDocked: false });
    await off.report({ state: 8, charge_status: 1 });

    expect(off.publishedOperationalState()).toBe(0);
    expect(off.sensor("docked")).toBe(true);

    // With the toggle on, the same robot publishes CHARGING (65). Same sensor
    // reading, different published value: the sensor does not depend on it.
    const on = createVacuum({ extended: true, chargingDocked: true });
    await on.report({ state: 8, charge_status: 1 });

    expect(on.publishedOperationalState()).toBe(65);
    expect(on.sensor("docked")).toBe(true);
  });

  test("a robot drawing power is docked even when it reports no state at all", async () => {
    // charge_status on its own is a complete answer: the robot is on the dock
    // drawing power whatever it says it is doing.
    const vacuum = createVacuum({ extended: true, chargingDocked: true });
    await vacuum.report({ state: 0, charge_status: 1 });

    expect(vacuum.sensor("docked")).toBe(true);
  });
});

describe("the Cleaning sensor says exactly what the Apple Home tile says", () => {
  const cases = TOGGLES.flatMap((toggle) =>
    ROBOT_STATES.map((robotState) => [
      robotState.label,
      toggle.label,
      toggle,
      robotState,
    ])
  );

  test.each(cases)(
    "a robot %s agrees with the tile with %s",
    async (_stateLabel, _toggleLabel, toggle, robotState) => {
      // Asserted as an identity rather than a truth table on purpose. The tile
      // and the sensor answering differently is the failure a user would report
      // ("Home says it is cleaning and the automation never ran"), and it is
      // also the only way this can go wrong that a fixed table would miss —
      // a table has to be updated when the run-mode rule changes, and the last
      // three releases all changed it.
      const vacuum = createVacuum(toggle);
      await vacuum.report({
        state: robotState.state,
        charge_status: robotState.charge_status,
      });

      expect(vacuum.sensor("cleaning")).toBe(
        vacuum.publishedRunMode() === RUN_MODE_CLEANING
      );
    }
  );

  test("a cleaning robot does read as cleaning, so the identity is not vacuously true", async () => {
    // An implementation that returned false for everything would satisfy every
    // assertion above if the tile also said Idle everywhere. Both values have to
    // actually occur.
    const vacuum = createVacuum({ extended: true, chargingDocked: true });

    await vacuum.report({ state: 5, charge_status: 0 });
    expect(vacuum.sensor("cleaning")).toBe(true);
    expect(vacuum.publishedRunMode()).toBe(RUN_MODE_CLEANING);

    await vacuum.report({ state: 8, charge_status: 1 });
    expect(vacuum.sensor("cleaning")).toBe(false);
  });
});

describe("a dock chore does not make the Cleaning sensor announce a run", () => {
  // 3.6.2 fixed exactly this on the Apple Home tile for issue #9: a Q Revo
  // sitting still while its dock emptied itself announced a cleaning that
  // started and finished. The sensor is a second surface for the same claim, so
  // the same rule is asserted here rather than assumed to carry over.
  const CHORES = [
    { label: "emptying the dust bin", state: 22 },
    { label: "washing the mop", state: 23 },
    { label: "updating maps", state: 29 },
  ];

  const cases = TOGGLES.flatMap((toggle) =>
    CHORES.map((chore) => [chore.label, toggle.label, toggle, chore])
  );

  test.each(cases)(
    "%s in the dock leaves the sensor Open, with %s",
    async (_choreLabel, _toggleLabel, toggle, chore) => {
      const vacuum = createVacuum(toggle);
      await vacuum.report({ state: 8, charge_status: 1 });
      expect(vacuum.sensor("cleaning")).toBe(false);

      await vacuum.report({ state: chore.state, charge_status: 1 });
      expect(vacuum.sensor("cleaning")).toBe(false);
    }
  );

  test.each(cases)(
    "%s mid-run leaves the sensor Closed, with %s",
    async (_choreLabel, _toggleLabel, toggle, chore) => {
      // The mirror image, and the reason the rule is "inherit" rather than
      // "a chore is never cleaning": a robot that empties its bin in the middle
      // of a run must not report that the run ended and started again.
      const vacuum = createVacuum(toggle);
      await vacuum.report({ state: 5, charge_status: 0 });
      expect(vacuum.sensor("cleaning")).toBe(true);

      await vacuum.report({ state: chore.state, charge_status: 0 });
      expect(vacuum.sensor("cleaning")).toBe(true);

      await vacuum.report({ state: 5, charge_status: 0 });
      expect(vacuum.sensor("cleaning")).toBe(true);
    }
  );
});

describe("not docked and not cleaning is the answer to 'is it stuck'", () => {
  // The automation pponce described in issue #3, asserted as a pair because
  // neither sensor answers it alone.
  test.each(TOGGLES)(
    "a robot halted with an error reads Open on both, with $label",
    async (toggle) => {
      const vacuum = createVacuum(toggle);
      await vacuum.report({ state: 12, charge_status: 0 });

      expect(vacuum.sensor("docked")).toBe(false);
      expect(vacuum.sensor("cleaning")).toBe(false);
    }
  );

  test.each(TOGGLES)(
    "and a robot that is merely cleaning does not, with $label",
    async (toggle) => {
      // Without this the pair above would also be satisfied by two sensors that
      // are always Open, which would make every automation fire constantly.
      const vacuum = createVacuum(toggle);
      await vacuum.report({ state: 5, charge_status: 0 });

      expect([vacuum.sensor("docked"), vacuum.sensor("cleaning")]).not.toEqual([
        false,
        false,
      ]);
    }
  );
});

describe("nothing is claimed before the robot has reported", () => {
  test.each(HOMEKIT_STATE_SENSOR_KEYS)(
    "%s answers null when the robot has said nothing usable",
    async (key) => {
      const vacuum = createVacuum({ extended: true, chargingDocked: true });
      await vacuum.report({ state: 0, charge_status: 0 });

      expect(vacuum.sensor(key)).toBeNull();
    }
  );

  test("state 0 is treated as silence rather than as a robot off its dock", async () => {
    // State 0 is not in Roborock's enum — it falls through the mapping to
    // STOPPED, which is indistinguishable from a robot genuinely idle on the
    // floor. Believing it would report "not docked" for a docked robot for the
    // 27 seconds a Q7 takes to report in, then flip, firing every automation
    // triggered on the robot leaving its dock, on every restart.
    const vacuum = createVacuum({ extended: true, chargingDocked: true });
    await vacuum.report({ state: 0, charge_status: 0 });
    expect(vacuum.sensor("docked")).toBeNull();

    await vacuum.report({ state: 8, charge_status: 1 });
    expect(vacuum.sensor("docked")).toBe(true);
  });
});

describe("the sensor accessory writes nothing it was not told", () => {
  function createSensor({ definition, cachedValue } = {}) {
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
    const information = {
      setCharacteristic: jest.fn(() => information),
    };

    const accessory = {
      displayName: "Vicky Docked",
      UUID: "uuid-sensor",
      context: cachedValue === undefined ? {} : { lastValue: cachedValue },
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
      definition ?? STATE_SENSOR_DEFINITIONS[0],
      "device-1"
    );

    return { sensor, accessory, service, characteristics, platform };
  }

  test("true is Closed and false is Open, for every sensor", () => {
    // One polarity across the whole feature: detected means the state the
    // sensor is named after is true. Two sensors with opposite conventions is
    // the kind of thing nobody reads the README to discover.
    for (const definition of STATE_SENSOR_DEFINITIONS) {
      const { sensor, characteristics } = createSensor({ definition });

      sensor.refresh(true);
      expect(characteristics.get("ContactSensorState")).toBe(CONTACT_DETECTED);

      sensor.refresh(false);
      expect(characteristics.get("ContactSensorState")).toBe(
        CONTACT_NOT_DETECTED
      );
    }
  });

  test("null is a no-op, not a value", () => {
    const { sensor, service, characteristics } = createSensor();
    sensor.refresh(false);
    service.updateCharacteristic.mockClear();

    sensor.refresh(null);

    expect(service.updateCharacteristic).not.toHaveBeenCalled();
    expect(characteristics.get("ContactSensorState")).toBe(
      CONTACT_NOT_DETECTED
    );
  });

  test("an unchanged value is not republished", () => {
    // Three robots on a 15 s poll would otherwise push six identical HAP
    // updates a minute for state that has not moved.
    const { sensor, service } = createSensor();
    sensor.refresh(true);
    service.updateCharacteristic.mockClear();

    sensor.refresh(true);

    expect(service.updateCharacteristic).not.toHaveBeenCalled();
  });

  test("the last value is remembered so a restart does not move the sensor", () => {
    const { sensor, accessory } = createSensor();
    sensor.refresh(false);
    expect(accessory.context.lastValue).toBe(false);

    // A restart: the cached accessory comes back and answers reads from the
    // value it persisted, rather than from the guess the constructor would
    // otherwise have to make.
    const restarted = createSensor({ cachedValue: false });
    expect(restarted.characteristics.get("ContactSensorState")).toBe(
      CONTACT_NOT_DETECTED
    );
  });

  test("with no cached value the resting state is Closed", () => {
    // Almost every robot is in its dock almost all of the time, so Closed is
    // the reading least likely to move when real data arrives.
    const { characteristics } = createSensor();
    expect(characteristics.get("ContactSensorState")).toBe(CONTACT_DETECTED);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: survival.
// ---------------------------------------------------------------------------

class FakeService {
  constructor(name) {
    this.name = name;
    this.characteristics = new Map();
  }
  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, {
        value: null,
        removeAllListeners() {
          return this;
        },
        onGet() {
          return this;
        },
        onSet() {
          return this;
        },
      });
    }
    return this.characteristics.get(type);
  }
  setCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
  updateCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
}

class FakePlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.context = {};
    this.services = new Map();
  }
  getService(type) {
    return this.services.get(type);
  }
  addService(type, name) {
    const service = new FakeService(name);
    this.services.set(type, service);
    return service;
  }
}

function cachedActionSwitch(duid, action) {
  return {
    UUID: `uuid:${actionSwitchUuidSeed(duid, action)}`,
    displayName: `Robot ${duid} ${action}`,
    context: { duid, kind: ACTION_SWITCH_KIND, action },
    services: new Map(),
    getService(type) {
      return this.services.get(type);
    },
    addService(type, name) {
      const service = new FakeService(name);
      this.services.set(type, service);
      return service;
    },
  };
}

function cachedStateSensor(duid, sensor) {
  return {
    UUID: `uuid:${stateSensorUuidSeed(duid, sensor)}`,
    displayName: `Robot ${duid} ${sensor}`,
    context: { duid, kind: STATE_SENSOR_KIND, sensor },
    services: new Map(),
    getService(type) {
      return this.services.get(type);
    },
    addService(type, name) {
      const service = new FakeService(name);
      this.services.set(type, service);
      return service;
    },
  };
}

function legacyAccessory(uuid, displayName) {
  return { UUID: uuid, displayName, context: {} };
}

function createSyncPlatform({ config = {}, accessories = [] } = {}) {
  const platform = Object.create(RoborockPlatform.prototype);

  platform.platformConfig = config;
  platform.log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  platform.accessories = accessories;
  platform.actionSwitches = new Map();
  platform.stateSensors = new Map();
  platform.matterVacuums = new Map();
  platform.registered = [];
  platform.unregistered = [];
  platform.Service = {
    AccessoryInformation: "Information",
    Switch: "Switch",
    ContactSensor: "ContactSensor",
  };
  platform.Characteristic = {
    Manufacturer: "Manufacturer",
    Model: "Model",
    SerialNumber: "SerialNumber",
    Name: "Name",
    On: "On",
    ContactSensorState: "ContactSensorState",
  };
  platform.roborockAPI = {
    getVacuumDeviceInfo: (duid, property) =>
      property === "name" ? `Robot ${duid}` : `sn-${duid}`,
    getProductAttribute: () => "roborock.vacuum.a75",
  };
  platform.api = {
    hap: { uuid: { generate: (seed) => `uuid:${seed}` } },
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories: jest.fn((_p, _n, list) => {
      platform.registered.push(...list.map((entry) => entry.UUID));
    }),
    unregisterPlatformAccessories: jest.fn((_p, _n, list) => {
      platform.unregistered.push(...list.map((entry) => entry.UUID));
    }),
  };

  return platform;
}

const DEVICES = [{ duid: "device-1" }];

describe("every HAP accessory kind survives every sweep", () => {
  test("the Matter-only sweep spares both kinds and still takes the legacy ones", () => {
    const platform = createSyncPlatform({
      accessories: [
        legacyAccessory("uuid-legacy-fan", "Vicky"),
        cachedActionSwitch("device-1", "dock"),
        cachedStateSensor("device-1", "docked"),
        legacyAccessory("uuid-legacy-pause", "Vicky Pause Cleaning"),
      ],
    });

    platform.removeLegacyHomeKitAccessories();

    expect(platform.unregistered.sort()).toEqual([
      "uuid-legacy-fan",
      "uuid-legacy-pause",
    ]);
    expect(platform.accessories.map((entry) => entry.UUID).sort()).toEqual([
      `uuid:${actionSwitchUuidSeed("device-1", "dock")}`,
      `uuid:${stateSensorUuidSeed("device-1", "docked")}`,
    ]);
  });

  test("the switch sync leaves the sensors alone", () => {
    // A sensor has no `action` in its context, so before the kinds were
    // partitioned the switch sync saw a switch for an action nobody had
    // enabled and unregistered every sensor on the first discovery pass.
    const sensor = cachedStateSensor("device-1", "docked");
    const platform = createSyncPlatform({
      config: {
        enableHomeKitActionSwitches: true,
        homeKitActionSwitches: ["dock"],
      },
      accessories: [sensor],
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.unregistered).not.toContain(sensor.UUID);
    expect(platform.accessories).toContain(sensor);
  });

  test("the sensor sync leaves the switches alone", () => {
    const actionSwitch = cachedActionSwitch("device-1", "dock");
    const platform = createSyncPlatform({
      config: {
        enableHomeKitStateSensors: true,
        homeKitStateSensors: ["docked"],
      },
      accessories: [actionSwitch],
    });

    platform.syncStateSensors(DEVICES);

    expect(platform.unregistered).not.toContain(actionSwitch.UUID);
    expect(platform.accessories).toContain(actionSwitch);
  });

  test("both syncs still remove their own kind when the config stops asking", () => {
    // The other half of the partition: sparing the other kind must not turn
    // into sparing everything, or a sensor the user switched off would stay in
    // their Home app forever.
    const platform = createSyncPlatform({
      config: { enableHomeKitStateSensors: false },
      accessories: [cachedStateSensor("device-1", "docked")],
    });

    platform.syncStateSensors(DEVICES);

    expect(platform.unregistered).toEqual([
      `uuid:${stateSensorUuidSeed("device-1", "docked")}`,
    ]);
  });

  test("an empty device list does not delete a sensor the config still wants", () => {
    // getHomeDetail() throwing reaches discovery as "the account has no
    // robots". Deleting working sensors out of live automations over a DNS blip
    // is the trap unregisterStaleMatterAccessories already documents.
    const platform = createSyncPlatform({
      config: {
        enableHomeKitStateSensors: true,
        homeKitStateSensors: ["docked"],
      },
      accessories: [cachedStateSensor("device-1", "docked")],
    });

    platform.syncStateSensors([]);

    expect(platform.unregistered).toEqual([]);
  });
});

describe("the sensors are an opt-in", () => {
  test("off by default: no config at all publishes nothing", () => {
    const platform = createSyncPlatform();

    platform.syncStateSensors(DEVICES);

    expect(platform.registered).toEqual([]);
    expect(platform.stateSensors.size).toBe(0);
  });

  test("the master switch alone means Docked", () => {
    // `[]` and "absent" are different answers: absent falls back to the one
    // state most automations read, empty publishes nothing. A user who ticks
    // the box and saves must not get silence.
    const platform = createSyncPlatform({
      config: { enableHomeKitStateSensors: true },
    });

    platform.syncStateSensors(DEVICES);

    expect(platform.registered).toEqual([
      `uuid:${stateSensorUuidSeed("device-1", "docked")}`,
    ]);
  });

  test("an explicitly empty list publishes nothing", () => {
    const platform = createSyncPlatform({
      config: {
        enableHomeKitStateSensors: true,
        homeKitStateSensors: [],
      },
    });

    platform.syncStateSensors(DEVICES);

    expect(platform.registered).toEqual([]);
  });

  test("unknown and duplicated keys are dropped rather than published", () => {
    const platform = createSyncPlatform({
      config: {
        enableHomeKitStateSensors: true,
        homeKitStateSensors: ["docked", "docked", "mopping", "cleaning"],
      },
    });

    platform.syncStateSensors(DEVICES);

    expect(platform.registered.sort()).toEqual(
      [
        `uuid:${stateSensorUuidSeed("device-1", "cleaning")}`,
        `uuid:${stateSensorUuidSeed("device-1", "docked")}`,
      ].sort()
    );
  });

  test("a sensor's UUID seed cannot collide with a switch's", () => {
    // Both kinds hang off the same duid on the same bridge. A shared seed would
    // make one overwrite the other in the accessory cache.
    for (const key of HOMEKIT_STATE_SENSOR_KEYS) {
      expect(stateSensorUuidSeed("device-1", key)).not.toBe(
        actionSwitchUuidSeed("device-1", key)
      );
    }
    expect(stateSensorUuidSeed("device-1", "docked")).toMatch(
      /^hap:roborock:state:/
    );
  });
});

describe("the settings surfaces all know about the sensors", () => {
  // 3.1.0 shipped a setting wired into three of the four places it has to be
  // and a user reported, correctly, that the fix did not work. The four are the
  // schema, the plugin's types, the settings page markup, and the settings
  // page script — both the load half and the save half.
  const fs = require("fs");
  const path = require("path");
  const read = (relative) =>
    fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

  const SURFACES = [
    { name: "the settings schema", file: "config.schema.json" },
    { name: "the plugin's config type", file: "src/types.ts" },
    {
      name: "the settings page markup",
      file: "homebridge-ui/public/index.html",
    },
    { name: "the settings page script", file: "homebridge-ui/public/index.js" },
  ];

  test.each(SURFACES)("$name names both settings", ({ file }) => {
    const source = read(file);
    // The markup names the fields by element id rather than by config key.
    const pattern = file.endsWith(".html")
      ? [
          /enable-homekit-state-sensors/,
          /homekit-state-docked/,
          /homekit-state-cleaning/,
        ]
      : [/enableHomeKitStateSensors/, /homeKitStateSensors/];

    for (const expected of pattern) {
      expect(source).toMatch(expected);
    }
  });

  test("the settings page both loads and saves the selection", () => {
    // Loading without saving silently discards the user's choice on the next
    // save; saving without loading shows every box unticked to somebody who
    // already enabled them. Both halves, named separately.
    const js = read("homebridge-ui/public/index.js");

    expect(js).toMatch(/applyStateSensorSelection\(readStateSensorSelection\(/);
    expect(js).toMatch(/homeKitStateSensors: getSavedStateSensorSelection\(\)/);
    expect(js).toMatch(
      /enableHomeKitStateSensors: Boolean\(\s*elements\.enableHomeKitStateSensors\?\.checked\s*\)/
    );
  });

  test("the form cannot save the silent-nothing state", () => {
    const js = read("homebridge-ui/public/index.js");
    const saver = js.slice(
      js.indexOf("function getSavedStateSensorSelection"),
      js.indexOf("function getStateSensorSelection")
    );

    expect(saver).toMatch(/return \["docked"\]/);
  });

  test("the schema's list and the plugin's list are the same list", () => {
    const schema = JSON.parse(read("config.schema.json"));
    const offered = schema.schema.properties.homeKitStateSensors.items.enum
      .slice()
      .sort();

    expect(offered).toEqual([...HOMEKIT_STATE_SENSOR_KEYS].sort());
  });

  test("every offered key has a definition, and every definition is offered", () => {
    expect(
      STATE_SENSOR_DEFINITIONS.map((definition) => definition.key).sort()
    ).toEqual([...HOMEKIT_STATE_SENSOR_KEYS].sort());
  });
});
