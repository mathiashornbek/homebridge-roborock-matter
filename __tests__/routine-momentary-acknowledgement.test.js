"use strict";

const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;
const {
  isRecoverableScheduleCloudFailure,
} = require("../src/hap_schedule_accessory.ts");

const Characteristic = {
  Name: "Name",
  ConfiguredName: "ConfiguredName",
  On: "On",
};

const Service = {
  Switch: {
    UUID: "switch-uuid",
  },
};

class FakeCharacteristic {
  constructor(value) {
    this.value = value;
  }

  setValue(value) {
    this.value = value;
    return this;
  }

  removeAllListeners() {
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }

  onGet(handler) {
    this.getHandler = handler;
    return this;
  }
}

class FakeService {
  constructor(serviceType, displayName, subtype) {
    this.UUID = serviceType.UUID;
    this.subtype = subtype;
    this.displayName = displayName;
    this.characteristics = new Map();
    this.setCharacteristic(Characteristic.Name, displayName);
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new FakeCharacteristic());
    }

    return this.characteristics.get(type);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).setValue(value);
    return this;
  }

  addOptionalCharacteristic(type) {
    this.getCharacteristic(type);
    return this;
  }

  updateCharacteristic(type, value) {
    this.getCharacteristic(type).setValue(value);
    return this;
  }
}

class FakeAccessory {
  constructor(displayName) {
    this.displayName = displayName;
    this.context = {};
    this.services = [];
  }

  getServiceById(serviceType, subtype) {
    return this.services.find(
      (service) =>
        service.UUID === serviceType.UUID && service.subtype === subtype
    );
  }

  addService(serviceType, displayName, subtype) {
    const service = new FakeService(serviceType, displayName, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service) {
    this.services = this.services.filter((candidate) => candidate !== service);
  }
}

function makePlatform() {
  return {
    Service,
    Characteristic,
    roborockAPI: {},
    api: {
      updatePlatformAccessories: jest.fn(),
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
  };
}

function makeCoordinator(platform, accessory) {
  const coordinator = new RoborockHapScheduleAccessory(
    platform,
    accessory,
    "device-1"
  );

  coordinator.vacuumName = "Test Vacuum";
  accessory.displayName = "Test Vacuum Schedules";
  return coordinator;
}

function schedule(id, enabled = true) {
  return {
    id,
    enabled,
    timer: [id, enabled ? "on" : "off"],
  };
}

function switchService(accessory, id) {
  return accessory.getServiceById(
    Service.Switch,
    "roborock-schedule-" + encodeURIComponent(id)
  );
}

describe("routine momentary acknowledgement", () => {
  test.each([false, true])(
    "accepts immediately and handles later failure=%s",
    async (fail) => {
      const platform = makePlatform();
      let finish, reject;
      platform.roborockAPI.executeCloudScene = jest.fn(
        () =>
          new Promise((resolve, rej) => {
            finish = resolve;
            reject = rej;
          })
      );
      const accessory = new FakeAccessory("Routines");
      const c = makeCoordinator(platform, accessory);
      c.routineAccessory = accessory;
      c.exposeRoutines = true;
      c.syncRoutines([{ id: "scene-1", name: "Kitchen routine" }]);
      const on = accessory.services[0].getCharacteristic(Characteristic.On);
      expect(on.setHandler(true)).toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(platform.roborockAPI.executeCloudScene).toHaveBeenCalledWith(
        "scene-1"
      );
      if (fail) reject(new Error("cloud refused"));
      else finish();
      await new Promise((resolve) => setImmediate(resolve));
      if (fail)
        expect(platform.log.warn).toHaveBeenCalledWith(
          'Accepted Home routine "Kitchen routine" for Test Vacuum failed: cloud refused'
        );
      else expect(platform.log.warn).not.toHaveBeenCalled();
      expect(on.getHandler()).toBe(false);
      on.setHandler(false);
      expect(platform.roborockAPI.executeCloudScene).toHaveBeenCalledTimes(1);
      c.stopRuntime();
    }
  );
});
