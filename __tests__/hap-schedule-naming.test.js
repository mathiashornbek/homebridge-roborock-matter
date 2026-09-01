"use strict";

const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

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

describe("HAP schedule names and stable group identity", () => {
  test("multiple schedules cannot overwrite their shared group identity", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1"), schedule("timer-2", false)]);

    expect(switchService(accessory, "timer-1").displayName).toBe(
      "Test Vacuum Schedule 1"
    );
    expect(switchService(accessory, "timer-2").displayName).toBe(
      "Test Vacuum Schedule 2"
    );

    expect(accessory.displayName).toBe("Test Vacuum Schedules");
    expect(accessory.context).toEqual({
      kind: "hapExtension",
      extension: "schedules",
      duid: "device-1",
    });

    expect(
      switchService(accessory, "timer-1").getCharacteristic(Characteristic.Name)
        .value
    ).toBe("Test Vacuum Schedule 1");
    expect(
      switchService(accessory, "timer-2").getCharacteristic(Characteristic.Name)
        .value
    ).toBe("Test Vacuum Schedule 2");
  });

  test("generic labels are repaired while a Home custom name survives restart sync", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const firstCoordinator = makeCoordinator(platform, accessory);

    firstCoordinator.sync([schedule("timer-1"), schedule("timer-2")]);

    const firstService = switchService(accessory, "timer-1");
    const secondService = switchService(accessory, "timer-2");

    firstService.displayName = "Switch";
    firstService.setCharacteristic(Characteristic.Name, "Switch");

    secondService.displayName = "Switch 1";
    secondService.setCharacteristic(Characteristic.Name, "Switch 1");
    secondService.getCharacteristic(Characteristic.ConfiguredName).setValue("");

    firstService
      .getCharacteristic(Characteristic.ConfiguredName)
      .setValue("Weekday Upstairs");

    const restoredCoordinator = makeCoordinator(platform, accessory);
    restoredCoordinator.sync([schedule("timer-1"), schedule("timer-2")]);

    expect(firstService.displayName).toBe("Test Vacuum Schedule 1");
    expect(secondService.displayName).toBe("Test Vacuum Schedule 2");
    expect(accessory.displayName).toBe("Test Vacuum Schedules");
    expect(
      switchService(accessory, "timer-1").getCharacteristic(
        Characteristic.ConfiguredName
      ).value
    ).toBe("Weekday Upstairs");
    expect(
      switchService(accessory, "timer-2").getCharacteristic(
        Characteristic.ConfiguredName
      ).value
    ).toBe("Test Vacuum Schedule 2");
  });

  test("a generated name follows deterministic renumbering", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1"), schedule("timer-2")]);
    coordinator.sync([schedule("timer-2")]);

    expect(accessory.displayName).toBe("Test Vacuum Schedules");
    expect(
      switchService(accessory, "timer-2").getCharacteristic(
        Characteristic.ConfiguredName
      ).value
    ).toBe("Test Vacuum Schedule 1");
  });

  test("a custom name survives deterministic renumbering", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1"), schedule("timer-2")]);

    switchService(accessory, "timer-2")
      .getCharacteristic(Characteristic.ConfiguredName)
      .setValue("Weekend Downstairs");

    coordinator.sync([schedule("timer-2")]);

    expect(
      switchService(accessory, "timer-2").getCharacteristic(
        Characteristic.ConfiguredName
      ).value
    ).toBe("Weekend Downstairs");
  });

  test("normal shutdown preserves service identity and a Home custom name", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1"), schedule("timer-2", false)]);

    const firstService = switchService(accessory, "timer-1");
    const secondService = switchService(accessory, "timer-2");

    secondService
      .getCharacteristic(Characteristic.ConfiguredName)
      .setValue("Weekend Downstairs");

    const originalServices = [...accessory.services];

    coordinator.shutdown();

    expect(accessory.services).toEqual(originalServices);
    expect(switchService(accessory, "timer-1")).toBe(firstService);
    expect(switchService(accessory, "timer-2")).toBe(secondService);
    expect(platform.api.updatePlatformAccessories).not.toHaveBeenCalled();

    const restoredCoordinator = makeCoordinator(platform, accessory);

    expect(restoredCoordinator.restoreScheduleHandlersFromAccessory()).toBe(
      true
    );
    expect(switchService(accessory, "timer-1")).toBe(firstService);
    expect(switchService(accessory, "timer-2")).toBe(secondService);
    expect(
      secondService.getCharacteristic(Characteristic.ConfiguredName).value
    ).toBe("Weekend Downstairs");
  });

  test("switching a schedule off updates state without removing its service", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1", true)]);

    const service = switchService(accessory, "timer-1");
    platform.api.updatePlatformAccessories.mockClear();

    coordinator.sync([schedule("timer-1", false)]);

    expect(switchService(accessory, "timer-1")).toBe(service);
    expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
    expect(platform.api.updatePlatformAccessories).not.toHaveBeenCalled();
  });

  test("an authoritative deleted schedule removes only its own service", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1"), schedule("timer-2")]);

    const retainedService = switchService(accessory, "timer-2");
    platform.api.updatePlatformAccessories.mockClear();

    coordinator.sync([schedule("timer-2")]);

    expect(switchService(accessory, "timer-1")).toBeUndefined();
    expect(switchService(accessory, "timer-2")).toBe(retainedService);
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([
      accessory,
    ]);
  });

  test("intentional schedule exposure removal deletes switch services", () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory("Test Vacuum Schedules");
    const coordinator = makeCoordinator(platform, accessory);

    coordinator.sync([schedule("timer-1"), schedule("timer-2", false)]);
    platform.api.updatePlatformAccessories.mockClear();

    coordinator.removeScheduleServices();

    expect(
      accessory.services.filter(
        (service) => service.UUID === Service.Switch.UUID
      )
    ).toHaveLength(0);
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([
      accessory,
    ]);
  });

  test("a HAP write uses one minimal server-timer command and one verification read", async () => {
    jest.useFakeTimers();

    try {
      const platform = makePlatform();
      const command = jest.fn().mockResolvedValue("ok");
      platform.roborockAPI = {
        getServerTimers: jest
          .fn()
          .mockResolvedValue([["timer-complex", "on", 1]]),
        vacuums: {
          "device-1": { command },
        },
      };

      const accessory = new FakeAccessory("Test Vacuum Schedules");
      const coordinator = makeCoordinator(platform, accessory);
      const timer = ["timer-complex", "off", 1];

      coordinator.sync([
        {
          id: "timer-complex",
          enabled: false,
          timer,
        },
      ]);
      const onCharacteristic = switchService(
        accessory,
        "timer-complex"
      ).getCharacteristic(Characteristic.On);
      const writePromise = onCharacteristic.setHandler(true);

      await jest.advanceTimersByTimeAsync(4000);
      await writePromise;

      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith(
        "device-1",
        "upd_server_timer",
        [["timer-complex", "on"]],
        {
          requestTimeoutMs: 10000,
          preferCloud: true,
          waitForResult: true,
          throwOnError: true,
        }
      );
      expect(platform.roborockAPI.getServerTimers).toHaveBeenCalledWith(
        "device-1",
        expect.objectContaining({ preferCloud: true })
      );
      expect(timer).toEqual(["timer-complex", "off", 1]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("rapid HomeKit changes send only the final schedule value", async () => {
    jest.useFakeTimers();

    try {
      const platform = makePlatform();
      const command = jest.fn().mockResolvedValue("ok");
      platform.roborockAPI = {
        getServerTimers: jest.fn().mockResolvedValue([["timer-rapid", "on"]]),
        vacuums: {
          "device-1": { command },
        },
      };

      const accessory = new FakeAccessory("Test Vacuum Schedules");
      const coordinator = makeCoordinator(platform, accessory);
      coordinator.sync([
        {
          id: "timer-rapid",
          enabled: false,
          timer: ["timer-rapid", "off"],
        },
      ]);
      const onCharacteristic = switchService(
        accessory,
        "timer-rapid"
      ).getCharacteristic(Characteristic.On);

      const first = onCharacteristic.setHandler(true);
      const second = onCharacteristic.setHandler(false);
      const final = onCharacteristic.setHandler(true);

      await jest.advanceTimersByTimeAsync(3500);
      await Promise.all([first, second, final]);

      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith(
        "device-1",
        "upd_server_timer",
        [["timer-rapid", "on"]],
        expect.objectContaining({ preferCloud: true, waitForResult: true })
      );
      expect(platform.roborockAPI.getServerTimers).toHaveBeenCalledWith(
        "device-1",
        expect.objectContaining({ preferCloud: true })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("one batch of distinct schedule writes uses one consolidated verification read", async () => {
    jest.useFakeTimers();

    try {
      const platform = makePlatform();
      const command = jest.fn().mockResolvedValue("ok");
      platform.roborockAPI = {
        getServerTimers: jest.fn().mockResolvedValue([
          ["timer-1", "on"],
          ["timer-2", "on"],
        ]),
        vacuums: {
          "device-1": { command },
        },
      };

      const accessory = new FakeAccessory("Test Vacuum Schedules");
      const coordinator = makeCoordinator(platform, accessory);
      coordinator.sync([
        schedule("timer-1", false),
        schedule("timer-2", false),
      ]);

      const first = switchService(accessory, "timer-1")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);
      const second = switchService(accessory, "timer-2")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);

      await jest.advanceTimersByTimeAsync(500);
      expect(command).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(499);
      expect(command).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(command).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(3000);
      await Promise.all([first, second]);

      expect(command).toHaveBeenCalledTimes(2);
      expect(command.mock.calls.map((call) => call[2])).toEqual([
        [["timer-1", "on"]],
        [["timer-2", "on"]],
      ]);
      expect(platform.roborockAPI.getServerTimers).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an explicit throttle stops the rest of the vacuum batch without verification", async () => {
    jest.useFakeTimers();

    try {
      const platform = makePlatform();
      const throttle = Object.assign(new Error("Too many requests"), {
        status: 429,
      });
      const command = jest.fn().mockRejectedValue(throttle);
      platform.roborockAPI = {
        getServerTimers: jest.fn(),
        vacuums: {
          "device-1": { command },
        },
      };

      const accessory = new FakeAccessory("Test Vacuum Schedules");
      const coordinator = makeCoordinator(platform, accessory);
      coordinator.sync([
        schedule("timer-1", false),
        schedule("timer-2", false),
      ]);

      const first = switchService(accessory, "timer-1")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);
      const second = switchService(accessory, "timer-2")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);

      await jest.advanceTimersByTimeAsync(500);
      await Promise.all([first, second]);

      expect(command).toHaveBeenCalledTimes(1);
      expect(platform.roborockAPI.getServerTimers).not.toHaveBeenCalled();
      expect(
        switchService(accessory, "timer-1").getCharacteristic(Characteristic.On)
          .value
      ).toBe(false);
      expect(
        switchService(accessory, "timer-2").getCharacteristic(Characteristic.On)
          .value
      ).toBe(false);
      expect(platform.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("pausing this vacuum's schedule traffic")
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("one unconfirmed schedule gets one bounded fallback and one final batch verification", async () => {
    jest.useFakeTimers();

    try {
      const platform = makePlatform();
      const command = jest.fn().mockResolvedValue("ok");
      platform.roborockAPI = {
        getServerTimers: jest
          .fn()
          .mockResolvedValueOnce([
            ["timer-1", "on"],
            ["timer-2", "off"],
          ])
          .mockResolvedValueOnce([
            ["timer-1", "on"],
            ["timer-2", "on"],
          ]),
        vacuums: { "device-1": { command } },
      };

      const accessory = new FakeAccessory("Test Vacuum Schedules");
      const coordinator = makeCoordinator(platform, accessory);
      coordinator.sync([
        schedule("timer-1", false),
        schedule("timer-2", false),
      ]);

      const first = switchService(accessory, "timer-1")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);
      const second = switchService(accessory, "timer-2")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);

      await jest.advanceTimersByTimeAsync(4000);
      expect(command).toHaveBeenCalledTimes(3);
      expect(command).toHaveBeenLastCalledWith(
        "device-1",
        "upd_timer",
        ["timer-2", "on"],
        expect.objectContaining({ preferCloud: true, waitForResult: true })
      );

      await jest.advanceTimersByTimeAsync(3000);
      await Promise.all([first, second]);

      expect(platform.roborockAPI.getServerTimers).toHaveBeenCalledTimes(2);
      expect(platform.log.info).toHaveBeenCalledWith(
        "Schedule fallback verification for device-1: requested=2; primarySent=2; primaryConfirmed=1; fallbackNeeded=1; fallbackSent=1; fallbackConfirmed=1; failed=0."
      );
      expect(
        switchService(accessory, "timer-1").getCharacteristic(Characteristic.On)
          .value
      ).toBe(true);
      expect(
        switchService(accessory, "timer-2").getCharacteristic(Characteristic.On)
          .value
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("one failed primary write does not poison another schedule in the batch", async () => {
    jest.useFakeTimers();

    try {
      const platform = makePlatform();
      const primaryFailure = new Error("timer-1 refused");
      const command = jest.fn(async (_duid, method, parameters) => {
        if (method === "upd_server_timer" && parameters[0][0] === "timer-1") {
          throw primaryFailure;
        }
        return "ok";
      });
      platform.roborockAPI = {
        getServerTimers: jest.fn().mockResolvedValue([
          ["timer-1", "off"],
          ["timer-2", "on"],
        ]),
        vacuums: { "device-1": { command } },
      };

      const accessory = new FakeAccessory("Test Vacuum Schedules");
      const coordinator = makeCoordinator(platform, accessory);
      coordinator.sync([
        schedule("timer-1", false),
        schedule("timer-2", false),
      ]);

      const first = switchService(accessory, "timer-1")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);
      const second = switchService(accessory, "timer-2")
        .getCharacteristic(Characteristic.On)
        .setHandler(true);

      await jest.advanceTimersByTimeAsync(4000);
      await Promise.all([first, second]);

      expect(command).toHaveBeenCalledTimes(2);
      expect(platform.roborockAPI.getServerTimers).toHaveBeenCalledTimes(1);
      expect(
        switchService(accessory, "timer-1").getCharacteristic(Characteristic.On)
          .value
      ).toBe(false);
      expect(
        switchService(accessory, "timer-2").getCharacteristic(Characteristic.On)
          .value
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
