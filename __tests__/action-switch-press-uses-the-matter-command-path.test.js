"use strict";

// A switch is a second way into the same commands, and the tempting shape is
// the short one: call app_charge and be done. That shape re-earns four bugs
// this codebase has already paid for — acknowledgement waiting and timing logs
// (issue #12), forwarding a command the cached snapshot claims is unnecessary
// (issue #4), the retry when Roborock times out but is still cleaning, and the
// optimistic cluster write that moves the Matter tile so the robot does not
// look Ready while it drives home.
//
// So the rule under test is not "the switch docks the robot". It is that the
// switch reaches the robot through the existing command path and is
// distinguishable in the log from a press on the Matter tile — because when a
// scheduled dock does not happen, the first question is which surface asked.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const RoborockActionSwitchAccessory =
  require("../src/action_switch_accessory").default;
const { getActionSwitchDefinition } = require("../src/action_switch_accessory");
const { setTimeout: realSetTimeout } = require("node:timers");

function flush() {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

class FakeCharacteristic {
  constructor() {
    this.value = null;
  }
  onGet(handler) {
    this.getHandler = handler;
    return this;
  }
  onSet(handler) {
    this.setHandler = handler;
    return this;
  }
  removeAllListeners() {
    this.removedListeners = (this.removedListeners || 0) + 1;
    return this;
  }
}

class FakeService {
  constructor(name) {
    this.name = name;
    this.characteristics = new Map();
  }
  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new FakeCharacteristic());
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

function createHarness({
  action = "dock",
  status = { state: 5 },
  findMe = jest.fn().mockResolvedValue(undefined),
  withVacuum = true,
} = {}) {
  const matterUpdates = [];
  const appCharge = jest.fn().mockResolvedValue(undefined);
  const appPause = jest.fn().mockResolvedValue(undefined);
  const appStartCollectDust = jest.fn().mockResolvedValue(undefined);

  const platform = {
    platformConfig: {
      enableMatterServiceArea: false,
      enableMatterPowerSource: true,
      enableMatterCleanMode: false,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: async (uuid, cluster, attributes) => {
        matterUpdates.push({ uuid, cluster, attributes });
      },
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    Service: { AccessoryInformation: "Information", Switch: "Switch" },
    Characteristic: {
      Manufacturer: "Manufacturer",
      Model: "Model",
      SerialNumber: "SerialNumber",
      Name: "Name",
      On: "On",
    },
    getVacuumModel: () => "roborock.vacuum.a08",
    getVacuumSerialNumber: () => "sn-1",
    roborockAPI: {
      getVacuumDeviceInfo: (_duid, property) =>
        property === "name" ? "Vicky" : "",
      getProductAttribute: () => "roborock.vacuum.a08",
      getVacuumDeviceStatus: (_duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true }),
      app_start: jest.fn().mockResolvedValue(undefined),
      app_stop: jest.fn().mockResolvedValue(undefined),
      app_pause: appPause,
      app_charge: appCharge,
      app_start_collect_dust: appStartCollectDust,
      supportsDustCollection: () => true,
      find_me: findMe,
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };

  const matterAccessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = withVacuum
    ? new RoborockMatterVacuumAccessory(
        platform,
        matterAccessory,
        { duid: "device-1" },
        true
      )
    : null;
  platform.getMatterVacuum = () => vacuum || undefined;

  const definition = getActionSwitchDefinition(action);
  const accessory = new FakePlatformAccessory(
    `Vicky ${definition.nameSuffix}`,
    `uuid-switch-${action}`
  );
  const actionSwitch = new RoborockActionSwitchAccessory(
    platform,
    accessory,
    definition,
    "device-1"
  );

  const on = accessory.getService("Switch").getCharacteristic("On");

  return {
    platform,
    vacuum,
    accessory,
    actionSwitch,
    on,
    appCharge,
    appPause,
    appStartCollectDust,
    findMe,
    matterUpdates,
    press: async () => {
      await on.setHandler(true);
      await flush();
    },
  };
}

describe("pressing the switch reaches the robot the way the tile does", () => {
  test("Return to Dock sends the same Roborock command", async () => {
    const harness = createHarness();

    await harness.press();

    expect(harness.appCharge).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({ waitForResult: true, throwOnError: true })
    );
  });

  test("the log names the switch, not Matter", async () => {
    const harness = createHarness();

    await harness.press();

    expect(harness.platform.log.info).toHaveBeenCalledWith(
      "Sending Vicky back to dock from the Home switch."
    );
  });

  test("the Matter tile moves too, so the robot is not left reading Ready", async () => {
    const harness = createHarness();

    await harness.press();

    const operationalState = harness.matterUpdates.filter(
      (update) => update.cluster === "rvcOperationalState"
    );
    expect(operationalState.length).toBeGreaterThan(0);
  });

  test("Pause routes to the pause command", async () => {
    const harness = createHarness({ action: "pause" });

    await harness.press();

    expect(harness.appPause).toHaveBeenCalledTimes(1);
    expect(harness.platform.log.info).toHaveBeenCalledWith(
      "Pausing Vicky from the Home switch."
    );
  });

  test("Empty Bin starts dust collection while the robot is docked", async () => {
    const harness = createHarness({
      action: "empty",
      status: { state: 8, charge_status: 1 },
    });

    await harness.press();

    expect(harness.appStartCollectDust).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({ waitForResult: true, throwOnError: true })
    );
    expect(harness.platform.log.info).toHaveBeenCalledWith(
      "Emptying Vicky's dust bin from the Home switch."
    );
  });

  test("Empty Bin reaches the robot when the cached dock snapshot is stale", async () => {
    const harness = createHarness({ action: "empty", status: { state: 5 } });

    await harness.press();

    expect(harness.appStartCollectDust).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({ waitForResult: true, throwOnError: true })
    );
    expect(harness.platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("cached state may be stale")
    );
  });

  test("Find routes to the locate command", async () => {
    const harness = createHarness({ action: "locate" });

    await harness.press();

    expect(harness.findMe).toHaveBeenCalledWith("device-1", expect.any(Object));
  });
});

describe("the switch behaves like a button, not a state", () => {
  test("it reads off even straight after a press", async () => {
    const harness = createHarness();

    await harness.press();

    expect(await harness.on.getHandler()).toBe(false);
  });

  test("it turns itself off again", async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      // HAP writes the new value before it calls the set handler, which is
      // what leaves the switch stuck on if nothing puts it back.
      harness.on.value = true;
      harness.on.setHandler(true);
      expect(harness.on.value).toBe(true);

      jest.advanceTimersByTime(2000);

      expect(harness.on.value).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("switching it off sends no command", async () => {
    const harness = createHarness();

    await harness.on.setHandler(false);
    await flush();

    // Otherwise the automatic reset above would dock the robot a second time,
    // and every automation would fire twice.
    expect(harness.appCharge).not.toHaveBeenCalled();
  });

  test("a restored accessory never comes back on", () => {
    const harness = createHarness();

    // A cached switch restored in the on position would tell an automation
    // that a command nobody sent is still running.
    expect(harness.on.value).toBe(false);
  });

  test("re-configuring a cached accessory does not double-bind the handler", () => {
    const harness = createHarness();

    harness.actionSwitch.configureAccessory();

    // Two set handlers on one characteristic means one press, two commands.
    expect(harness.on.removedListeners).toBeGreaterThanOrEqual(2);
  });
});

describe("a press that cannot be served fails quietly and legibly", () => {
  test("no robot yet: a warning, not a thrown accessory error", async () => {
    const harness = createHarness({ withVacuum: false });

    await expect(harness.on.setHandler(true)).resolves.not.toThrow();
    expect(harness.platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not set up yet")
    );
  });

  test("a command that rejects does not escape the set handler", async () => {
    const harness = createHarness();
    harness.platform.roborockAPI.app_charge = jest
      .fn()
      .mockRejectedValue(new Error("boom"));

    await expect(harness.press()).resolves.toBeUndefined();
  });
});
