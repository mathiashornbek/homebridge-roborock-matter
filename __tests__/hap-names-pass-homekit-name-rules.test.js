"use strict";

const { hapName } = require("../src/hap_name.ts");
const RoborockPlatform = require("../src/platform.ts").default;
const {
  ACTION_SWITCH_KIND,
  actionSwitchUuidSeed,
} = require("../src/action_switch_accessory.ts");
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

// Copied from @homebridge/hap-nodejs 2.2.2 dist/lib/util/checkName.js (the
// version Homebridge 2.4.0 ships). The installed dev hap-nodejs predates it.
const CHECK_NAME =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}’'&!._:;()/,-]*[\p{L}\p{N}]$/u;

describe("hapName", () => {
  test.each([
    ["Q5 Max+", "Pause", "Q5 Max Plus Pause"],
    ["Saugen+", "", "Saugen Plus"],
    ["Küche 🍳", "", "Küche"],
    ["1️⃣ Floor", "", "1 Floor"],
    ["Ends with '", "", "Ends with"],
    ["🤖", "Docked", "Roborock Vacuum Docked"],
    ["B", "", "Roborock Vacuum"],
  ])("%j + %j -> %j", (base, suffix, expected) => {
    expect(hapName(base, "Roborock Vacuum", suffix)).toBe(expected);
    expect(hapName(base, "Roborock Vacuum", suffix)).toMatch(CHECK_NAME);
  });

  test.each([
    "Vicky",
    "Wohnzimmer  Flur",
    "Mom's",
    "清扫 客厅",
    "S7 MaxV Ultra",
  ])("a name that is already valid is left exactly as it is: %j", (name) => {
    expect(hapName(name, "x", "Docked")).toBe(`${name} Docked`);
  });

  // HAP judges the whole name: these all passed in 3.38.0 and must not change.
  test.each([
    ["Staubsauger (OG)", "Docked"],
    ["Roborock (Küche)", "Schedules"],
    ["Robo Jr.", "Docked"],
    ["Kids'", "Docked"],
    ["R", "Docked"],
  ])("%j + %j is valid as a whole and is left alone", (base, suffix) => {
    expect(`${base} ${suffix}`).toMatch(CHECK_NAME);
    expect(hapName(base, "Roborock Vacuum", suffix)).toBe(`${base} ${suffix}`);
  });

  test("in front of a suffix a cleaned name keeps its closing bracket", () => {
    expect(hapName("Q5 Max+ (OG)", "Roborock Vacuum", "Docked")).toBe(
      "Q5 Max Plus (OG) Docked"
    );
    expect(hapName("Roborock (S8+)", "Roborock Vacuum", "Docked")).toBe(
      "Roborock (S8 Plus) Docked"
    );
  });

  test("a valid name in decomposed Unicode is not re-normalised", () => {
    const decomposed = "\u1112\u1161\u11ab\u1100\u1173\u11af";
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
    expect(hapName(decomposed, "x", "Docked")).toBe(`${decomposed} Docked`);
  });

  test("a long robot name is cut, never the suffix, and fits Name's 64", () => {
    const name = hapName(
      "Robot " + "x".repeat(60),
      "x",
      "Dirty Water Tank Full"
    );
    expect(name.endsWith(" Dirty Water Tank Full")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(CHECK_NAME);
  });
});

function fakeService(name) {
  const characteristics = new Map();
  return {
    displayName: name,
    optionalCharacteristics: [],
    testCharacteristic(type) {
      return characteristics.has(type);
    },
    getCharacteristic(type) {
      if (!characteristics.has(type)) {
        characteristics.set(type, {
          value: null,
          setValue(value) {
            this.value = value;
            return this;
          },
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
      return characteristics.get(type);
    },
    setCharacteristic(type, value) {
      this.getCharacteristic(type).value = value;
      return this;
    },
    updateCharacteristic(type, value) {
      this.getCharacteristic(type).value = value;
      return this;
    },
  };
}

function cachedAccessory(uuid, displayName, context) {
  const services = new Map();
  return {
    UUID: uuid,
    displayName,
    context,
    services,
    getService: (type) => services.get(type),
    addService(type, name) {
      services.set(type, fakeService(name));
      return services.get(type);
    },
  };
}

test("a cached 'Q5 Max+ Pause' switch is renamed in place, not replaced", () => {
  const uuid = `uuid:${actionSwitchUuidSeed("d1", "pause")}`;
  const cached = cachedAccessory(uuid, "Q5 Max+ Pause", {
    duid: "d1",
    kind: ACTION_SWITCH_KIND,
    action: "pause",
  });
  cached.addService("Information", "");
  cached.getService("Information").setCharacteristic("Name", "Q5 Max+ Pause");
  cached.addService("Switch", "Q5 Max+ Pause");

  const platform = Object.create(RoborockPlatform.prototype);
  Object.assign(platform, {
    platformConfig: {
      enableHomeKitActionSwitches: true,
      homeKitActionSwitches: ["pause"],
    },
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
    accessories: [cached],
    actionSwitches: new Map(),
    stateSensors: new Map(),
    matterVacuums: new Map(),
    Service: { AccessoryInformation: "Information", Switch: "Switch" },
    Characteristic: {
      Name: "Name",
      Manufacturer: "Manufacturer",
      Model: "Model",
      SerialNumber: "SerialNumber",
      On: "On",
    },
    roborockAPI: {
      getVacuumDeviceInfo: (_duid, key) => (key === "name" ? "Q5 Max+" : "sn"),
      getProductAttribute: () => "roborock.vacuum.a10",
    },
    api: {
      hap: { uuid: { generate: (seed) => `uuid:${seed}` } },
      registerPlatformAccessories: jest.fn(),
      unregisterPlatformAccessories: jest.fn(),
      updatePlatformAccessories: jest.fn(),
    },
  });

  platform.syncActionSwitches([{ duid: "d1" }]);

  expect(cached.UUID).toBe(uuid);
  expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
  expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  // Saved at once, so an unclean stop cannot restore the old name.
  expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([cached]);
  for (const name of [
    cached.displayName,
    cached.getService("Information").getCharacteristic("Name").value,
    cached.getService("Switch").displayName,
    cached.getService("Switch").getCharacteristic("Name").value,
  ]) {
    expect(name).toBe("Q5 Max Plus Pause");
  }
});

test("a restored 'Saugen+' routine follows to 'Saugen Plus' without a false rename line, and a Home rename survives", async () => {
  const routineAccessory = {
    displayName: "Rocky Routines",
    context: {},
    services: [],
    getService(type) {
      return this.services.find((s) => s.UUID === type.UUID && !s.subtype);
    },
    getServiceById(type, subtype) {
      return this.services.find(
        (s) => s.UUID === type.UUID && s.subtype === subtype
      );
    },
    addService(type, name, subtype) {
      const service = fakeService(name);
      service.UUID = type.UUID;
      service.subtype = subtype;
      service.addOptionalCharacteristic = () => service;
      if (name) service.setCharacteristic("Name", name);
      this.services.push(service);
      return service;
    },
    removeService() {},
  };
  const Switch = { UUID: "switch" };
  const mirrored = routineAccessory.addService(
    Switch,
    "Saugen+",
    "roborock-routine-1"
  );
  mirrored.setCharacteristic("ConfiguredName", "Saugen+");
  const renamed = routineAccessory.addService(
    Switch,
    "Wischen+",
    "roborock-routine-2"
  );
  renamed.setCharacteristic("ConfiguredName", "Morgens");

  const platform = {
    Service: { Switch, AccessoryInformation: { UUID: "info" } },
    Characteristic: {
      Name: "Name",
      ConfiguredName: "ConfiguredName",
      On: "On",
      Manufacturer: "Manufacturer",
      Model: "Model",
      SerialNumber: "SerialNumber",
    },
    roborockAPI: {},
    api: { updatePlatformAccessories: jest.fn() },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
  const coordinator = new RoborockHapScheduleAccessory(
    platform,
    cachedAccessory("m", "Rocky Schedules", {}),
    "d1"
  );
  coordinator.attachRoutineAccessory(routineAccessory, () => {});
  coordinator.syncRoutines([
    { id: "1", name: "Saugen+", raw: {}, schedule: null },
    { id: "2", name: "Wischen+", raw: {}, schedule: null },
  ]);

  expect(mirrored.getCharacteristic("Name").value).toBe("Saugen Plus");
  expect(mirrored.getCharacteristic("ConfiguredName").value).toBe(
    "Saugen Plus"
  );
  expect(renamed.getCharacteristic("ConfiguredName").value).toBe("Morgens");
  expect(platform.log.info).not.toHaveBeenCalledWith(
    expect.stringMatching(/is now called/)
  );
});
