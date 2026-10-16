"use strict";

// Exercise the optimistic acknowledgement and later correction against real
// hap-nodejs characteristics, including its post-onSet value assignment.

const path = require("path");
// Homebridge's own hap-nodejs, wherever npm placed it.
const hap = require(
  require.resolve("hap-nodejs", {
    paths: [path.dirname(require.resolve("homebridge/package.json"))],
  })
);
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

const DUID = "duid-a144";

class Accessory {
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
    const service = new serviceType(displayName, subtype);
    this.services.push(service);
    return service;
  }
  removeService(service) {
    this.services = this.services.filter((s) => s !== service);
  }
}

function sceneParam(enabled) {
  return JSON.stringify({
    triggers: [
      {
        id: 7033921,
        name: "TIMER",
        type: "TIMER",
        entityId: "",
        param: `{"cron": "0 9 * * 3", "type": "NORMAL", "enabled": ${enabled}, "repeated": true, "timeZoneId": "Europe/Berlin"}`,
      },
    ],
    action: {
      type: "S",
      items: [
        {
          id: 1,
          type: "CMD",
          name: "Kitchen",
          entityId: DUID,
          param:
            '{"id":1,"method":"do_scenes_segments","params":{"data":[{"tid":"1","segs":[{"sid":2}]}],"source":101}}',
          finishDpIds: [130],
        },
      ],
    },
  });
}

function setup({ refuse, ambiguous = false }) {
  let failReads = false;
  const scenes = [
    {
      id: 1,
      name: "Mornings",
      param: sceneParam(true),
      enabled: true,
      extra: null,
      type: "WORKFLOW",
    },
  ];
  const roborockAPI = {
    getServerTimers: jest.fn(async () => {
      throw new Error("Not FCC robot (code -10007)");
    }),
    getCloudScenes: jest.fn(async () => {
      if (failReads) throw new Error("fixture read unavailable");
      return scenes.map((s) => ({ ...s }));
    }),
    updateCloudSceneParam: jest.fn(async (sceneId, param) => {
      if (refuse) {
        throw new Error("The Roborock cloud refused the change (HTTP 500).");
      }
      scenes[0].param = JSON.stringify(param);
      if (ambiguous) {
        failReads = true;
        throw Object.assign(new Error("write reply lost"), {
          code: "ECONNRESET",
        });
      }
    }),
    setCloudSceneEnabled: jest.fn(async (sceneId, enabled) => {
      scenes[0].enabled = enabled;
    }),
    vacuums: { [DUID]: { command: jest.fn(async () => "ok") } },
  };
  const platform = {
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    roborockAPI,
    api: { hap, updatePlatformAccessories: jest.fn() },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
  const manager = new Accessory("Rocky Schedules");
  const coordinator = new RoborockHapScheduleAccessory(platform, manager, DUID);
  return {
    coordinator,
    manager,
    platform,
    setReadFailure: (value) => {
      failReads = value;
    },
  };
}

function onOf(manager) {
  return manager
    .getServiceById(hap.Service.Switch, "roborock-schedule-scene%3A1")
    .getCharacteristic(hap.Characteristic.On);
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a refused write leaves HAP's value on the state Roborock still has", async () => {
  const { coordinator, manager, platform } = setup({ refuse: true });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);
  expect(on.value).toBe(true);
  const changes = [];
  on.on("change", (change) => changes.push(change.newValue));

  const request = on.handleSetRequest(false).then(
    () => "resolved",
    (status) => status
  );
  await jest.advanceTimersByTimeAsync(5000);

  expect(await request).toBe("resolved");
  expect(on.value).toBe(true);
  expect(changes).toContain(false);
  expect(changes.at(-1)).toBe(true);
  expect(platform.log.warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /Schedule display rollback.*Rocky.*Mornings.*not a user change/
    )
  );
});

test("a write that succeeds still reads as the new state", async () => {
  const { coordinator, manager } = setup({ refuse: false });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);

  const request = on.handleSetRequest(false).then(
    () => "resolved",
    (status) => status
  );
  await jest.advanceTimersByTimeAsync(5000);

  expect(await request).toBe("resolved");
  expect(on.value).toBe(false);
});

test("a cooldown-suppressed retry is corrected after real HAP stores the requested value", async () => {
  const { coordinator, manager } = setup({ refuse: true });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);

  const first = on.handleSetRequest(false).catch((status) => status);
  await jest.advanceTimersByTimeAsync(5000);
  await first;

  const retry = on.handleSetRequest(false).then(
    () => "resolved",
    (status) => status
  );
  await jest.advanceTimersByTimeAsync(10);

  expect(await retry).toBe("resolved");
  expect(on.value).toBe(true);
});

test("a cached optimistic characteristic is restored from separately saved confirmation after restart", async () => {
  const { coordinator, manager, platform } = setup({ refuse: false });
  await coordinator.initialize("Rocky");
  let finish;
  coordinator.enqueueScheduleWrite = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const on = onOf(manager);
  await on.handleSetRequest(false);
  expect(on.value).toBe(false);
  // Homebridge serializes this BEFORE signalling shutdown.
  const cachedContext = JSON.parse(JSON.stringify(manager.context));
  const cachedValue = on.value;
  expect(cachedContext.scheduleDisplayStates["scene:1"].confirmed).toBe(true);
  coordinator.stopRuntime();
  finish(true);
  await jest.advanceTimersByTimeAsync(0);
  manager.context = cachedContext;
  on.updateValue(cachedValue);
  const restarted = new RoborockHapScheduleAccessory(platform, manager, DUID);
  restarted.vacuumName = "Rocky";
  expect(restarted.restoreScheduleHandlersFromAccessory()).toBe(true);
  expect(on.value).toBe(true);
  expect(platform.log.warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /Schedule display rollback.*Rocky.*Mornings.*before restart/
    )
  );
  restarted.stopRuntime();
  expect(jest.getTimerCount()).toBe(0);
});

test.each([true, false])(
  "an unverified applied write stays unknown and one follow-up read resolves it (read recovers=%s)",
  async (recovers) => {
    const { coordinator, manager, platform, setReadFailure } = setup({
      ambiguous: true,
    });
    await coordinator.initialize("Rocky");
    const on = onOf(manager);
    await on.handleSetRequest(false);
    await jest.advanceTimersByTimeAsync(5001);
    expect(on.value).toBe(false);
    expect(manager.context.scheduleDisplayStates["scene:1"].confirmed).toBe(
      true
    );
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Schedule outcome unknown.*Rocky.*Mornings.*no failed-command cooldown/
      )
    );
    const reads = platform.roborockAPI.getCloudScenes.mock.calls.length;
    setReadFailure(!recovers);
    await jest.advanceTimersByTimeAsync(3001);
    expect(platform.roborockAPI.getCloudScenes).toHaveBeenCalledTimes(
      reads + 1
    );
    expect(platform.roborockAPI.updateCloudSceneParam).toHaveBeenCalledTimes(1);
    if (recovers) {
      expect(manager.context.scheduleDisplayStates["scene:1"]).toEqual({
        confirmed: false,
      });
      expect(platform.log.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /Schedule outcome resolved by fresh read.*Rocky.*Mornings.*confirmed off/
        )
      );
    } else {
      expect(platform.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("outcome still unknown")
      );
      await jest.advanceTimersByTimeAsync(30_000);
      expect(platform.roborockAPI.getCloudScenes).toHaveBeenCalledTimes(
        reads + 1
      );
      setReadFailure(false);
      await coordinator.refreshDetailed(Date.now(), false, true);
      expect(platform.log.info).toHaveBeenCalledWith(
        expect.stringContaining("outcome resolved by fresh read")
      );
    }
    coordinator.stopRuntime();
  }
);

test("outcome unknown does not block a correct re-tap for thirty seconds", async () => {
  const { coordinator, manager, platform, setReadFailure } = setup({
    ambiguous: true,
  });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);
  await on.handleSetRequest(false);
  await jest.advanceTimersByTimeAsync(5001);
  setReadFailure(false);
  // A new explicit assignment can proceed before the failure cooldown would end.
  await on.handleSetRequest(false);
  await jest.advanceTimersByTimeAsync(2001);
  expect(platform.roborockAPI.updateCloudSceneParam).toHaveBeenCalledTimes(2);
  expect(platform.log.warn.mock.calls.flat().join("\n")).not.toContain(
    "request suppressed after failure"
  );
  coordinator.stopRuntime();
  await jest.advanceTimersByTimeAsync(20_000);
});

test("shutdown cancels pending feedback timers and late completions cannot change HAP", async () => {
  const { coordinator, manager } = setup({ refuse: false });
  await coordinator.initialize("Rocky");
  let reject;
  coordinator.enqueueScheduleWrite = jest.fn(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  const on = onOf(manager);
  await on.handleSetRequest(false);
  coordinator.stopRuntime();
  const before = on.value;
  reject(new Error("late shutdown failure"));
  await jest.advanceTimersByTimeAsync(10_000);
  expect(on.value).toBe(before);
  expect(jest.getTimerCount()).toBe(0);
  expect(manager.context.scheduleDisplayStates["scene:1"].confirmed).toBe(true);
});
