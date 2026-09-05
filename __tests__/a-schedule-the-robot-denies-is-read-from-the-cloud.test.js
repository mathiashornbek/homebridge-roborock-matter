"use strict";

/**
 * Issue #22, the switches.
 *
 * A Saros 10R answers `get_server_timer` with `-10007 "Not FCC robot"`, and
 * its owner's three schedules live as timer-driven Routines on the account.
 * From this release the schedule accessory reads both places, names a
 * Routine's switch after the Routine, writes it back the way the app does,
 * and stops asking a robot for a list it has said it does not have. A second
 * accessory, "<robot> Routines", runs any Routine on a press.
 *
 * These tests drive the real coordinator with a fake HAP accessory and a
 * fake shared API — the same fakes the naming tests use — so what is pinned
 * is behaviour at the switch, not the shape of a mock.
 */

const scheduleModule = require("../src/hap_schedule_accessory.ts");
const RoborockHapScheduleAccessory = scheduleModule.default;
const { isServerTimerRefusal, scheduleFromCloudScene, isHapRoutineAccessory } =
  scheduleModule;

const Characteristic = {
  Name: "Name",
  ConfiguredName: "ConfiguredName",
  On: "On",
  Manufacturer: "Manufacturer",
  Model: "Model",
  SerialNumber: "SerialNumber",
};

const Service = {
  Switch: { UUID: "switch-uuid" },
  AccessoryInformation: { UUID: "info-uuid" },
};

class FakeCharacteristic {
  constructor(value) {
    this.value = value;
    this.listeners = { get: [], set: [] };
  }
  setValue(value) {
    this.value = value;
    return this;
  }
  onSet(handler) {
    this.setHandler = handler;
    this.listeners.set.push(handler);
    return this;
  }
  onGet(handler) {
    this.getHandler = handler;
    this.listeners.get.push(handler);
    return this;
  }
  removeAllListeners(kind) {
    this.listeners[kind] = [];
    if (kind === "set") this.setHandler = undefined;
    if (kind === "get") this.getHandler = undefined;
  }
}

class FakeService {
  constructor(serviceType, displayName, subtype) {
    this.UUID = serviceType.UUID;
    this.subtype = subtype;
    this.displayName = displayName;
    this.characteristics = new Map();
    if (displayName !== undefined) {
      this.setCharacteristic(Characteristic.Name, displayName);
    }
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
    this.UUID = `uuid:${displayName}`;
  }
  getService(serviceType) {
    return this.services.find((s) => s.UUID === serviceType.UUID);
  }
  getServiceById(serviceType, subtype) {
    return this.services.find(
      (s) => s.UUID === serviceType.UUID && s.subtype === subtype
    );
  }
  addService(serviceType, displayName, subtype) {
    const service = new FakeService(serviceType, displayName, subtype);
    this.services.push(service);
    return service;
  }
  removeService(service) {
    this.services = this.services.filter((s) => s !== service);
  }
}

function makePlatform(roborockAPI) {
  return {
    Service,
    Characteristic,
    roborockAPI,
    api: { updatePlatformAccessories: jest.fn() },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
}

const DUID = "duid-a144";

function trigger(enabled, cron = "0 9 * * 3") {
  return {
    id: 7033921,
    name: "TIMER",
    type: "TIMER",
    entityId: "",
    param: `{"cron": "${cron}", "type": "NORMAL", "enabled": ${enabled}, "repeated": true, "timeZoneId": "Europe/Berlin"}`,
  };
}

function scene({
  id,
  name,
  timerEnabled = true,
  sceneEnabled = true,
  timer = true,
}) {
  return {
    id,
    name,
    param: JSON.stringify({
      triggers: timer ? [trigger(timerEnabled)] : [],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: "Schlafzimmer",
            entityId: DUID,
            param:
              '{"id":1,"method":"do_scenes_segments","params":{"data":[{"tid":"1","segs":[{"sid":2}]}],"source":101}}',
            finishDpIds: [130],
          },
        ],
      },
    }),
    enabled: sceneEnabled,
    extra: null,
    type: "WORKFLOW",
  };
}

/**
 * A shared-API stand-in with the cloud's scenes as mutable state, so a write
 * changes what the next read returns — which is what the verification step
 * depends on.
 */
function makeCloud({
  scenes = [],
  serverTimers = "refuse",
  allows = { param: true, enable: true },
} = {}) {
  const state = { scenes: scenes.map((s) => ({ ...s })) };
  const calls = [];

  const api = {
    calls,
    state,
    getServerTimers: jest.fn(async () => {
      calls.push({ method: "getServerTimers" });
      if (serverTimers === "refuse") {
        throw new Error(
          "The robot refused get_server_timer (cloud id 5): Not FCC robot (code -10007). This is the robot's own answer, not a plugin failure."
        );
      }
      if (serverTimers instanceof Error) throw serverTimers;
      return serverTimers;
    }),
    getCloudScenes: jest.fn(async () => {
      calls.push({ method: "getCloudScenes" });
      return state.scenes.map((s) => ({ ...s }));
    }),
    updateCloudSceneParam: jest.fn(async (sceneId, param) => {
      calls.push({ method: "updateCloudSceneParam", sceneId, param });
      if (!allows.param) {
        throw new Error(
          "The Roborock cloud does not offer PUT on user/scene/{id}/param (Allow: DELETE,OPTIONS); the schedule was left as it is."
        );
      }
      const target = state.scenes.find((s) => String(s.id) === String(sceneId));
      // The server re-creates the triggers under new ids and re-serialises
      // the nested params; the flag we sent is what survives.
      target.param = JSON.stringify({
        ...param,
        triggers: param.triggers.map((t, index) => ({
          ...t,
          id: 9_000_000 + index,
        })),
      });
    }),
    setCloudSceneEnabled: jest.fn(async (sceneId, enabled) => {
      calls.push({ method: "setCloudSceneEnabled", sceneId, enabled });
      const target = state.scenes.find((s) => String(s.id) === String(sceneId));
      target.enabled = enabled;
    }),
    executeCloudScene: jest.fn(async (sceneId) => {
      calls.push({ method: "executeCloudScene", sceneId });
    }),
    vacuums: { [DUID]: { command: jest.fn(async () => "ok") } },
  };
  return api;
}

function makeCoordinator(cloud, { routines = false } = {}) {
  const platform = makePlatform(cloud);
  const manager = new FakeAccessory("Rocky Schedules");
  const coordinator = new RoborockHapScheduleAccessory(platform, manager, DUID);
  let routineAccessory;
  const routineCounts = [];
  if (routines) {
    routineAccessory = new FakeAccessory("Rocky Routines");
    coordinator.vacuumName = "Rocky";
    coordinator.attachRoutineAccessory(routineAccessory, (count) =>
      routineCounts.push(count)
    );
  }
  return { platform, manager, coordinator, routineAccessory, routineCounts };
}

function scheduleSwitch(manager, id) {
  return manager.getServiceById(
    Service.Switch,
    `roborock-schedule-${encodeURIComponent(id)}`
  );
}

function routineSwitch(accessory, id) {
  return accessory.getServiceById(
    Service.Switch,
    `roborock-routine-${encodeURIComponent(id)}`
  );
}

async function flushTimers(ms) {
  await jest.advanceTimersByTimeAsync(ms);
}

describe("recognising a robot that refuses the device-side list", () => {
  test("the refusal is recognised by code, by message and by the API's own wording", () => {
    expect(isServerTimerRefusal(new Error("Not FCC robot (code -10007)"))).toBe(
      true
    );
    expect(isServerTimerRefusal(new Error("error -10007"))).toBe(true);
    expect(isServerTimerRefusal("robot refuses get_server_timer")).toBe(true);
    expect(isServerTimerRefusal(new Error("cloud timeout"))).toBe(false);
    expect(isServerTimerRefusal(undefined)).toBe(false);
  });

  test("a timer-driven scene becomes a schedule that knows where it came from", () => {
    const schedule = scheduleFromCloudScene({
      id: "14303871",
      name: "Saugen+",
      raw: scene({ id: 14303871, name: "Saugen+", timerEnabled: false }),
      schedule: null,
    });
    expect(schedule).toEqual({
      id: "scene:14303871",
      enabled: false,
      timer: ["14303871", "off"],
      source: "cloudScene",
      name: "Saugen+",
    });

    expect(
      scheduleFromCloudScene({
        id: "5",
        name: "Manual",
        raw: scene({ id: 5, name: "Manual", timer: false }),
        schedule: null,
      })
    ).toBeNull();
  });
});

describe("the schedules of a robot that keeps them in the cloud", () => {
  test("appear as switches named after the Routine, in the app's order", async () => {
    const cloud = makeCloud({
      scenes: [
        scene({ id: 14303871, name: "Saugen+" }),
        scene({ id: 11435521, name: "Hinten", timerEnabled: false }),
        scene({ id: 11435492, name: "Vorne" }),
        scene({ id: 5, name: "Nur Küche", timer: false }),
      ],
    });
    const { manager, coordinator, platform } = makeCoordinator(cloud);

    const result = await coordinator.initialize("Rocky");

    expect(result).toEqual({ success: true, hasSchedules: true });
    const switches = manager.services.filter((s) => s.UUID === "switch-uuid");
    expect(switches.map((s) => s.displayName)).toEqual([
      "Saugen+",
      "Hinten",
      "Vorne",
    ]);
    expect(
      scheduleSwitch(manager, "scene:11435521").getCharacteristic(
        Characteristic.On
      ).value
    ).toBe(false);
    expect(
      scheduleSwitch(manager, "scene:14303871").getCharacteristic(
        Characteristic.On
      ).value
    ).toBe(true);
    // The manual Routine is not a schedule and gets no schedule switch.
    expect(scheduleSwitch(manager, "scene:5")).toBeUndefined();
    // The refusal is explained once, at info, and is not a warning.
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/does not offer a device-side schedule list/)
    );
    expect(platform.log.warn).not.toHaveBeenCalled();
  });

  test("the device-side list is not asked for again once the robot refused it", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 1, name: "Saugen+" })],
    });
    const { coordinator } = makeCoordinator(cloud);

    await coordinator.initialize("Rocky");
    expect(cloud.getServerTimers).toHaveBeenCalledTimes(1);

    await coordinator.refresh();
    await coordinator.refresh();

    expect(cloud.getServerTimers).toHaveBeenCalledTimes(1);
    expect(cloud.getCloudScenes).toHaveBeenCalledTimes(3);
  });

  test("a scene switched off in the app is read as off on the next refresh", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen+" })] });
    const { manager, coordinator } = makeCoordinator(cloud);
    await coordinator.initialize("Rocky");

    cloud.state.scenes[0] = scene({
      id: 1,
      name: "Saugen+",
      timerEnabled: false,
    });
    await coordinator.refresh();

    expect(
      scheduleSwitch(manager, "scene:1").getCharacteristic(Characteristic.On)
        .value
    ).toBe(false);
  });
});

describe("switching a cloud schedule from HomeKit", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("off rewrites the Routine's param with the timer flag false, from a fresh reading, and confirms by reading back", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 14303871, name: "Saugen+" })],
    });
    const { manager, coordinator } = makeCoordinator(cloud);
    await coordinator.initialize("Rocky");
    const readsBefore = cloud.getCloudScenes.mock.calls.length;

    const on = scheduleSwitch(manager, "scene:14303871").getCharacteristic(
      Characteristic.On
    );
    const write = on.setHandler(false);
    await flushTimers(5000);
    await write;

    expect(cloud.updateCloudSceneParam).toHaveBeenCalledTimes(1);
    const [sceneId, param] = cloud.updateCloudSceneParam.mock.calls[0];
    expect(sceneId).toBe("14303871");
    expect(JSON.parse(param.triggers[0].param).enabled).toBe(false);
    // The action went back exactly as it came.
    expect(param.action).toEqual(
      JSON.parse(cloud.state.scenes[0].param).action
    );
    // A fresh read preceded the write, and a verification read followed it.
    expect(cloud.getCloudScenes.mock.calls.length).toBeGreaterThanOrEqual(
      readsBefore + 2
    );
    // No device-side fallback for a cloud scene.
    expect(cloud.vacuums[DUID].command).not.toHaveBeenCalled();
    expect(cloud.setCloudSceneEnabled).not.toHaveBeenCalled();
    expect(on.value).toBe(false);
  });

  test("on re-enables the scene itself when the app had disabled it at scene level", async () => {
    const cloud = makeCloud({
      scenes: [
        scene({
          id: 1,
          name: "Saugen+",
          timerEnabled: false,
          sceneEnabled: false,
        }),
      ],
    });
    const { manager, coordinator } = makeCoordinator(cloud);
    await coordinator.initialize("Rocky");

    const on = scheduleSwitch(manager, "scene:1").getCharacteristic(
      Characteristic.On
    );
    const write = on.setHandler(true);
    await flushTimers(5000);
    await write;

    expect(cloud.updateCloudSceneParam).toHaveBeenCalledTimes(1);
    expect(cloud.setCloudSceneEnabled).toHaveBeenCalledWith("1", true);
    expect(on.value).toBe(true);
  });

  test("a route that stops offering PUT reverts the switch with the reason, and sends nothing", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 1, name: "Saugen+" })],
      allows: { param: false, enable: true },
    });
    const { manager, coordinator, platform } = makeCoordinator(cloud);
    await coordinator.initialize("Rocky");

    const on = scheduleSwitch(manager, "scene:1").getCharacteristic(
      Characteristic.On
    );
    const write = on.setHandler(false);
    await flushTimers(5000);
    await write;

    expect(on.value).toBe(true);
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/does not offer PUT on user\/scene\/\{id\}\/param/)
    );
    expect(cloud.vacuums[DUID].command).not.toHaveBeenCalled();
  });

  test("a Routine deleted in the app between reading and switching is reported, not written", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen+" })] });
    const { manager, coordinator, platform } = makeCoordinator(cloud);
    await coordinator.initialize("Rocky");

    cloud.state.scenes = [];
    const on = scheduleSwitch(manager, "scene:1").getCharacteristic(
      Characteristic.On
    );
    const write = on.setHandler(false);
    await flushTimers(5000);
    await write;

    expect(cloud.updateCloudSceneParam).not.toHaveBeenCalled();
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no longer exists/)
    );
  });
});

describe("two sources on one robot", () => {
  test("device timers keep their numbering and a Routine's schedule keeps its name", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 7, name: "Abends" })],
      serverTimers: [
        ["1700000000000", "on", ["30 9 * * 1,5", ["start_clean", 102]]],
        ["1700000000001", "off", ["0 20 * * 3", ["start_clean", 102]]],
      ],
    });
    const { manager, coordinator } = makeCoordinator(cloud);

    await coordinator.initialize("Vicky");

    const names = manager.services
      .filter((s) => s.UUID === "switch-uuid")
      .map((s) => s.displayName);
    expect(names).toEqual(["Vicky Schedule 1", "Vicky Schedule 2", "Abends"]);
  });

  test("the first refresh fails as a whole when a source fails with nothing to fall back on", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 7, name: "Abends" })],
      serverTimers: new Error("cloud timeout"),
    });
    const { manager, coordinator, platform } = makeCoordinator(cloud);

    const result = await coordinator.initialize("Vicky");

    expect(result).toEqual({ success: false, hasSchedules: false });
    expect(manager.services.filter((s) => s.UUID === "switch-uuid")).toEqual(
      []
    );
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/cloud timeout.*Preserving existing schedules/)
    );
  });

  test("a source that fails later keeps its previous switches while the other is applied", async () => {
    let failTimers = false;
    const cloud = makeCloud({
      scenes: [scene({ id: 7, name: "Abends" })],
      serverTimers: [["1700000000000", "on"]],
    });
    cloud.getServerTimers.mockImplementation(async () => {
      if (failTimers) throw new Error("cloud timeout");
      return [["1700000000000", "on"]];
    });
    const { manager, coordinator } = makeCoordinator(cloud);
    await coordinator.initialize("Vicky");

    failTimers = true;
    cloud.state.scenes[0] = scene({
      id: 7,
      name: "Abends",
      timerEnabled: false,
    });
    const result = await coordinator.refresh();

    expect(result).toBe(true);
    expect(scheduleSwitch(manager, "1700000000000")).toBeDefined();
    expect(
      scheduleSwitch(manager, "scene:7").getCharacteristic(Characteristic.On)
        .value
    ).toBe(false);
  });

  test("a 4xx from the scene route is remembered and the device timers carry on", async () => {
    const cloud = makeCloud({ serverTimers: [["1700000000000", "on"]] });
    cloud.getCloudScenes.mockImplementation(async () => {
      const error = new Error("Request failed with status code 403");
      error.response = { status: 403 };
      throw error;
    });
    const { manager, coordinator, platform } = makeCoordinator(cloud);

    const result = await coordinator.initialize("Vicky");
    await coordinator.refresh();

    expect(result).toEqual({ success: true, hasSchedules: true });
    expect(scheduleSwitch(manager, "1700000000000")).toBeDefined();
    expect(cloud.getCloudScenes).toHaveBeenCalledTimes(1);
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/does not show Routines .*HTTP 403/)
    );
  });

  test("an API without the scene calls behaves exactly as before there were scenes", async () => {
    const cloud = makeCloud({ serverTimers: [["1700000000000", "on"]] });
    delete cloud.getCloudScenes;
    const { manager, coordinator, platform } = makeCoordinator(cloud);

    const result = await coordinator.initialize("Vicky");

    expect(result).toEqual({ success: true, hasSchedules: true });
    expect(scheduleSwitch(manager, "1700000000000")).toBeDefined();
    expect(platform.log.warn).not.toHaveBeenCalled();
  });
});

describe("the Routines accessory", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("gets one momentary switch per Routine, timer or not, and tells the platform how many", async () => {
    const cloud = makeCloud({
      scenes: [
        scene({ id: 1, name: "Saugen+" }),
        scene({ id: 2, name: "Nur Küche", timer: false }),
      ],
    });
    const { coordinator, routineAccessory, routineCounts } = makeCoordinator(
      cloud,
      { routines: true }
    );

    await coordinator.initialize("Rocky");

    expect(routineAccessory.context).toEqual({
      kind: "hapExtension",
      extension: "routines",
      duid: DUID,
    });
    expect(isHapRoutineAccessory(routineAccessory)).toBe(true);
    expect(routineAccessory.displayName).toBe("Rocky Routines");
    expect(
      routineAccessory.services
        .filter((s) => s.UUID === "switch-uuid")
        .map((s) => s.displayName)
    ).toEqual(["Saugen+", "Nur Küche"]);
    expect(routineCounts).toEqual([2]);
    expect(coordinator.routineCount).toBe(2);
  });

  test("a press runs the Routine and the switch falls back to off by itself", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen+" })] });
    const { coordinator, routineAccessory, platform } = makeCoordinator(cloud, {
      routines: true,
    });
    await coordinator.initialize("Rocky");

    const on = routineSwitch(routineAccessory, "1").getCharacteristic(
      Characteristic.On
    );
    await on.setHandler(true);

    expect(cloud.executeCloudScene).toHaveBeenCalledWith("1");
    expect(platform.log.info).toHaveBeenCalledWith(
      'Running Roborock routine "Saugen+".'
    );
    on.setValue(true);
    await flushTimers(1500);
    expect(on.value).toBe(false);
    // Turning it off is not a command.
    await on.setHandler(false);
    expect(cloud.executeCloudScene).toHaveBeenCalledTimes(1);
  });

  test("a Routine removed in the app loses its switch on the next reading", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 1, name: "Saugen+" }), scene({ id: 2, name: "B" })],
    });
    const { coordinator, routineAccessory, routineCounts } = makeCoordinator(
      cloud,
      { routines: true }
    );
    await coordinator.initialize("Rocky");

    cloud.state.scenes = [];
    await coordinator.refresh();

    expect(
      routineAccessory.services.filter((s) => s.UUID === "switch-uuid")
    ).toEqual([]);
    expect(routineCounts).toEqual([2, 0]);
  });

  test("a failed run is a warning, not a thrown handler", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen+" })] });
    cloud.executeCloudScene.mockRejectedValue(new Error("device offline"));
    const { coordinator, routineAccessory, platform } = makeCoordinator(cloud, {
      routines: true,
    });
    await coordinator.initialize("Rocky");

    const on = routineSwitch(routineAccessory, "1").getCharacteristic(
      Characteristic.On
    );
    await expect(on.setHandler(true)).resolves.toBeUndefined();
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Unable to run Roborock routine "Saugen\+": device offline/
      )
    );
  });

  test("switches restored from the cache work before the first reading and follow a rename after it", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen++" })] });
    const platform = makePlatform(cloud);
    const manager = new FakeAccessory("Rocky Schedules");
    const cached = new FakeAccessory("Rocky Routines");
    // What Homebridge hands back from its cache: the service, no handlers.
    cached.addService(Service.Switch, "Saugen+", "roborock-routine-1");

    const coordinator = new RoborockHapScheduleAccessory(
      platform,
      manager,
      DUID
    );
    coordinator.vacuumName = "Rocky";
    const counts = [];
    coordinator.attachRoutineAccessory(cached, (count) => counts.push(count));

    const on = routineSwitch(cached, "1").getCharacteristic(Characteristic.On);
    await on.setHandler(true);
    expect(cloud.executeCloudScene).toHaveBeenCalledWith("1");
    expect(counts).toEqual([1]);

    await coordinator.initialize("Rocky");
    expect(routineSwitch(cached, "1").displayName).toBe("Saugen++");
    // One handler after the re-bind, not two.
    expect(on.listeners.set).toHaveLength(1);
  });

  test("routines only: no schedule switch is made and the device-side list is not read", async () => {
    const cloud = makeCloud({
      scenes: [scene({ id: 1, name: "Saugen+" })],
      serverTimers: [["1700000000000", "on"]],
    });
    const { coordinator, manager, routineAccessory } = makeCoordinator(cloud, {
      routines: true,
    });
    coordinator.setScheduleExposure(false);

    const result = await coordinator.initialize("Rocky");

    expect(result).toEqual({ success: true, hasSchedules: false });
    expect(manager.services.filter((s) => s.UUID === "switch-uuid")).toEqual(
      []
    );
    expect(routineSwitch(routineAccessory, "1")).toBeDefined();
    expect(cloud.getServerTimers).not.toHaveBeenCalled();
  });

  test("removing the schedule half keeps the coordinator alive for the Routines", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen+" })] });
    const { coordinator, manager, routineAccessory } = makeCoordinator(cloud, {
      routines: true,
    });
    await coordinator.initialize("Rocky");
    expect(scheduleSwitch(manager, "scene:1")).toBeDefined();

    coordinator.removeScheduleServices();
    expect(scheduleSwitch(manager, "scene:1")).toBeUndefined();

    // Still refreshing, still running.
    cloud.state.scenes.push(scene({ id: 2, name: "Neu", timer: false }));
    await coordinator.refresh();
    expect(routineSwitch(routineAccessory, "2")).toBeDefined();
  });

  test("removing the Routines leaves the schedules untouched", async () => {
    const cloud = makeCloud({ scenes: [scene({ id: 1, name: "Saugen+" })] });
    const { coordinator, manager, routineAccessory } = makeCoordinator(cloud, {
      routines: true,
    });
    await coordinator.initialize("Rocky");

    coordinator.removeRoutineServices();

    expect(routineSwitch(routineAccessory, "1")).toBeUndefined();
    expect(scheduleSwitch(manager, "scene:1")).toBeDefined();
    expect(coordinator.routineCount).toBe(0);
  });
});
