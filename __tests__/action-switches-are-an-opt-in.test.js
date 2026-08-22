"use strict";

// These switches add accessories to somebody's Home app. A plugin update that
// did that by itself would be a bad surprise even when the feature is wanted,
// so the master setting is off until it is explicitly turned on, and the
// switch list is honoured exactly as saved.
//
// The removal half carries the trap. unregisterStaleMatterAccessories already
// documents it: a failed startup reaches discovery as "the account has no
// robots", because getHomeDetail() throws, the error is logged, and the
// callback still runs with an empty list. Removing accessories on that basis
// deletes working switches out of live automations over a DNS blip. Removing
// them because the CONFIG no longer asks for them is safe, because that answer
// does not come from the cloud.

const RoborockPlatform = require("../src/platform").default;
const { ACTION_SWITCH_KIND } = require("../src/action_switch_accessory");

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

function createPlatform({
  config = {},
  accessories = [],
  vacuums = new Map(),
} = {}) {
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
  platform.matterVacuums = vacuums;
  platform.registered = [];
  platform.unregistered = [];
  platform.Service = { AccessoryInformation: "Information", Switch: "Switch" };
  platform.Characteristic = {
    Manufacturer: "Manufacturer",
    Model: "Model",
    SerialNumber: "SerialNumber",
    Name: "Name",
    On: "On",
  };
  platform.roborockAPI = {
    getVacuumDeviceInfo: (duid, property) =>
      property === "name" ? `Robot ${duid}` : `sn-${duid}`,
    getProductAttribute: () => "roborock.vacuum.a08",
  };
  platform.api = {
    hap: { uuid: { generate: (seed) => `uuid:${seed}` } },
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories: jest.fn((_p, _n, list) => {
      platform.registered.push(...list.map((entry) => entry.displayName));
    }),
    unregisterPlatformAccessories: jest.fn((_p, _n, list) => {
      platform.unregistered.push(...list.map((entry) => entry.displayName));
    }),
  };

  return platform;
}

const DEVICES = [{ duid: "device-1" }];

describe("the action switches are off until they are asked for", () => {
  test("no config at all publishes nothing", () => {
    const platform = createPlatform();

    platform.syncActionSwitches(DEVICES);

    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(platform.accessories).toHaveLength(0);
  });

  test("the switch list alone is not enough without the master setting", () => {
    // Somebody who has picked actions but never ticked the box has not opted
    // in; a future default flip must not be able to sneak in through the list.
    const platform = createPlatform({
      config: { homeKitActionSwitches: ["dock", "pause"] },
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  test("the master setting with no list means Return to Dock", () => {
    const platform = createPlatform({
      config: { enableHomeKitActionSwitches: true },
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.registered).toEqual(["Robot device-1 Return to Dock"]);
  });

  test("a saved list is published exactly, and unknown keys are ignored", () => {
    const platform = createPlatform({
      config: {
        enableHomeKitActionSwitches: true,
        homeKitActionSwitches: ["pause", "selfDestruct", "locate"],
      },
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.registered.sort()).toEqual([
      "Robot device-1 Find",
      "Robot device-1 Pause",
    ]);
  });

  test("an action the robot cannot perform is never published", () => {
    const platform = createPlatform({
      config: {
        enableHomeKitActionSwitches: true,
        homeKitActionSwitches: ["dock", "locate"],
      },
      vacuums: new Map([
        [
          "device-1",
          {
            supportsHomeKitAction: (action) => action !== "locate",
            getDisplayName: () => "Robot device-1",
          },
        ],
      ]),
    });

    platform.syncActionSwitches(DEVICES);

    // A switch that silently does nothing is worse than no switch.
    expect(platform.registered).toEqual(["Robot device-1 Return to Dock"]);
    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("does not support that command")
    );
  });

  test("Empty Bin is published only for a robot with an auto-empty dock", () => {
    const platform = createPlatform({
      config: {
        enableHomeKitActionSwitches: true,
        homeKitActionSwitches: ["empty"],
      },
      vacuums: new Map([
        [
          "device-1",
          {
            supportsHomeKitAction: () => true,
            getDisplayName: () => "Robot device-1",
          },
        ],
      ]),
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.registered).toEqual(["Robot device-1 Empty Bin"]);

    platform.platformConfig.homeKitActionSwitches = ["empty", "dock"];
    platform.matterVacuums.get("device-1").supportsHomeKitAction = (action) =>
      action !== "empty";
    platform.syncActionSwitches(DEVICES);

    expect(platform.unregistered).toContain("Robot device-1 Empty Bin");
    expect(platform.registered).toContain("Robot device-1 Return to Dock");
  });

  test("one switch per robot per action", () => {
    const platform = createPlatform({
      config: {
        enableHomeKitActionSwitches: true,
        homeKitActionSwitches: ["dock"],
      },
    });

    platform.syncActionSwitches([{ duid: "device-1" }, { duid: "device-2" }]);

    expect(platform.registered.sort()).toEqual([
      "Robot device-1 Return to Dock",
      "Robot device-2 Return to Dock",
    ]);
  });

  test("a second discovery pass does not register the same switch twice", () => {
    const platform = createPlatform({
      config: { enableHomeKitActionSwitches: true },
    });

    platform.syncActionSwitches(DEVICES);
    platform.syncActionSwitches(DEVICES);

    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(platform.accessories).toHaveLength(1);
  });
});

describe("removing an action switch takes the config's word, not the cloud's", () => {
  function platformWithOneSwitch(config) {
    const platform = createPlatform({ config });
    platform.syncActionSwitches(DEVICES);
    platform.registered.length = 0;
    platform.api.registerPlatformAccessories.mockClear();
    return platform;
  }

  test("turning the feature off removes the switch", () => {
    const platform = platformWithOneSwitch({
      enableHomeKitActionSwitches: true,
    });

    platform.platformConfig.enableHomeKitActionSwitches = false;
    platform.syncActionSwitches(DEVICES);

    expect(platform.unregistered).toEqual(["Robot device-1 Return to Dock"]);
    expect(platform.accessories).toHaveLength(0);
    expect(platform.actionSwitches.size).toBe(0);
  });

  test("dropping one action from the list removes only that switch", () => {
    const platform = platformWithOneSwitch({
      enableHomeKitActionSwitches: true,
      homeKitActionSwitches: ["dock", "pause"],
    });

    platform.platformConfig.homeKitActionSwitches = ["dock"];
    platform.syncActionSwitches(DEVICES);

    expect(platform.unregistered).toEqual(["Robot device-1 Pause"]);
    expect(platform.accessories.map((entry) => entry.displayName)).toEqual([
      "Robot device-1 Return to Dock",
    ]);
  });

  test("an empty device list does NOT remove a still-enabled switch", () => {
    const platform = platformWithOneSwitch({
      enableHomeKitActionSwitches: true,
    });

    // getHomeDetail() threw; the discovery callback ran anyway. This is a bad
    // afternoon for the Roborock cloud, not an emptied account.
    platform.syncActionSwitches([]);

    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(platform.accessories).toHaveLength(1);
  });

  test("a robot that really is gone loses its switch", () => {
    const platform = platformWithOneSwitch({
      enableHomeKitActionSwitches: true,
    });

    // The account still answers, and it no longer lists device-1.
    platform.syncActionSwitches([{ duid: "device-2" }]);

    expect(platform.unregistered).toEqual(["Robot device-1 Return to Dock"]);
    expect(platform.registered).toEqual(["Robot device-2 Return to Dock"]);
  });

  test("turning the feature off works even while the cloud is down", () => {
    // The config half of the decision must not be held hostage by the guard
    // above: a user who unticks the box during an outage still gets the
    // accessory removed rather than a switch that reappears next restart.
    const platform = platformWithOneSwitch({
      enableHomeKitActionSwitches: true,
    });

    platform.platformConfig.enableHomeKitActionSwitches = false;
    platform.syncActionSwitches([]);

    expect(platform.unregistered).toEqual(["Robot device-1 Return to Dock"]);
  });
});

describe("the disabled path costs nothing at startup", () => {
  test("nothing enabled and nothing cached touches neither API nor accessory", () => {
    const platform = createPlatform();
    const getVacuumDeviceInfo = jest.fn();
    platform.roborockAPI.getVacuumDeviceInfo = getVacuumDeviceInfo;

    platform.syncActionSwitches([
      { duid: "device-1" },
      { duid: "device-2" },
      { duid: "device-3" },
    ]);

    // Not even a name lookup: the whole feature is one config read and one
    // length check for the users who never turn it on.
    expect(getVacuumDeviceInfo).not.toHaveBeenCalled();
    expect(platform.api.hap.uuid.generate).toBeDefined();
    expect(platform.actionSwitches.size).toBe(0);
  });
});

describe("the accessory that reaches the Homebridge cache", () => {
  test("carries the marker, the duid and the action", () => {
    const platform = createPlatform({
      config: { enableHomeKitActionSwitches: true },
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.accessories[0].context).toEqual({
      duid: "device-1",
      kind: ACTION_SWITCH_KIND,
      action: "dock",
    });
  });

  test("is registered under the real package name, not the platform's alias", () => {
    // PLUGIN_NAME has never matched package.json. Homebridge stores whatever
    // it is given as _associatedPlugin and looks it up on the next start; when
    // the lookup misses it falls back to searching by dynamic platform name,
    // and that fallback THROWS when two plugins claim the same platform name —
    // at which point the accessory is reported orphaned and deleted. Matter
    // keeps its own cache and cannot be moved without forcing every user to
    // re-pair, so the correct identifier is used here and only here.
    const platform = createPlatform({
      config: { enableHomeKitActionSwitches: true },
    });

    platform.syncActionSwitches(DEVICES);

    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledWith(
      "homebridge-roborock-matter",
      expect.any(String),
      expect.any(Array)
    );
  });

  test("gets a UUID that cannot collide with the robot's Matter accessory", () => {
    const platform = createPlatform({
      config: {
        enableHomeKitActionSwitches: true,
        homeKitActionSwitches: ["dock", "pause"],
      },
    });

    platform.syncActionSwitches(DEVICES);

    const uuids = platform.accessories.map((entry) => entry.UUID);
    expect(new Set(uuids).size).toBe(uuids.length);
    for (const uuid of uuids) {
      expect(uuid).toContain("hap:roborock:action:device-1");
      expect(uuid).not.toContain("matter:roborock");
    }
  });

  test("follows the robot when it is renamed in the Roborock app", () => {
    const platform = createPlatform({
      config: { enableHomeKitActionSwitches: true },
    });
    platform.syncActionSwitches(DEVICES);

    platform.roborockAPI.getVacuumDeviceInfo = (duid, property) =>
      property === "name" ? "Hoover" : `sn-${duid}`;
    platform.syncActionSwitches(DEVICES);

    expect(platform.accessories[0].displayName).toBe("Hoover Return to Dock");
    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });
});
