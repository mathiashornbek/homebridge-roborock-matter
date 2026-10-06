"use strict";

// The real schedule coordinator, HAP command adapter, request queue and MQTT
// receiver run here. Only broker I/O and payload encoding are simulated.
// A lost acknowledgement expires the actual production request timer.
const mockClients = [];
let mockPublish;
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const handlers = new Map();
    const client = {
      handlers,
      on: jest.fn((name, fn) => handlers.set(name, fn)),
      subscribe: jest.fn((topic, callback) => callback(null, [{ qos: 1 }])),
      publish: jest.fn((topic, payload) =>
        mockPublish(client, JSON.parse(payload.toString()))
      ),
      end: jest.fn(),
      endAsync: jest.fn(async () => {}),
      reconnect: jest.fn(),
      removeAllListeners: jest.fn(() => handlers.clear()),
    };
    mockClients.push(client);
    setTimeout(() => handlers.get("connect")?.({ sessionPresent: false }), 0);
    return client;
  }),
}));
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const scheduleModule = require("../src/hap_schedule_accessory.ts");
const { ScheduleAccountCoordinator } = scheduleModule;

let adapter,
  connector,
  queue,
  coordinator,
  timers,
  writes,
  reads,
  events,
  nextId,
  replacements;
const request = (enabled = true, scheduleId = "timer-1") => ({
  scheduleId,
  enabled,
});
const snapshot = () =>
  [...timers].map(([id, enabled]) => [id, enabled ? "on" : "off"]);
function reply(client, id, result, error) {
  adapter.message._decodeMsg.mockReturnValue({
    protocol: 102,
    payload: JSON.stringify({
      dps: { 102: JSON.stringify({ id, result, ...(error ? { error } : {}) }) },
    }),
  });
  client.handlers.get("message")?.(
    "rr/m/o/user/client/robot-a",
    Buffer.from("reply")
  );
}
async function run(requests = [request()]) {
  let result;
  const operation = coordinator
    .executeScheduleWriteBatch(requests)
    .then((value) => {
      result = value;
    });
  await jest.advanceTimersByTimeAsync(120_000);
  expect(result).toBeInstanceOf(Map);
  await operation;
  return result;
}
const writeEvents = () => events.filter((e) => e.method.startsWith("upd_"));

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  mockClients.length = 0;
  timers = new Map([["timer-1", false]]);
  writes = [];
  reads = [];
  events = [];
  nextId = 0;
  replacements = [];
  adapter = {
    config: { cloudOnlyMode: true },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map([["robot-a", "key"]]),
    devices: [{ duid: "robot-a" }],
    pendingRequests: new Map(),
    pendingB01MapRequests: new Map(),
    isRemoteDevice: async () => false,
    getRobotVersion: async () => "1.0",
    onlineChecker: async () => true,
    getRequestId: () => ++nextId,
    setTimeout,
    clearTimeout,
    setStateAsync: async () => {},
    updateTransportDiagnostics: async () => {},
    catchError: jest.fn(),
    localConnector: { isConnected: () => false, clearChunkBuffer: jest.fn() },
    message: {
      _decodeMsg: jest.fn(),
      buildPayload: async (duid, protocol, id, method, params) => ({
        id,
        method,
        params,
      }),
      buildRoborockMessage: async (duid, protocol, timestamp, payload) =>
        Buffer.from(JSON.stringify(payload)),
    },
  };
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  queue = new messageQueueHandler(adapter);
  adapter.getServerTimers = (duid, options) =>
    queue.sendRequest(duid, "get_server_timer", [], false, false, options);
  adapter.getCloudScenes = jest.fn(async () => []);
  adapter.vacuums = {
    "robot-a": {
      command: (duid, method, params, options) =>
        queue.sendRequest(duid, method, params, false, false, options),
    },
  };

  mockPublish = (client, message) => {
    events.push(message);
    if (message.method.startsWith("upd_")) {
      const action = writes.shift() || { apply: true, reply: true };
      const [id, state] =
        message.method === "upd_server_timer"
          ? message.params[0]
          : message.params;
      if (action.apply) timers.set(String(id), state === "on");
      action.effect?.();
      if (action.replace) replacements.push(connector.reconnectClient(true));
      if (action.error) reply(client, message.id, undefined, action.error);
      else if (action.reply) reply(client, message.id, ["ok"]);
    } else {
      const action = reads.shift() || {};
      action.effect?.();
      if (!action.silent)
        reply(
          client,
          message.id,
          "value" in action ? action.value : snapshot()
        );
    }
  };
  await connector.initUser({
    rriot: {
      u: "user",
      s: "secret",
      k: "key",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  await jest.advanceTimersByTimeAsync(0);

  coordinator = Object.create(scheduleModule.default.prototype);
  Object.assign(coordinator, {
    platform: { roborockAPI: adapter, log: adapter.log },
    duid: "robot-a",
    scheduleAccessories: new Map(),
    routineSwitches: new Map(),
    managerAccessory: {},
    vacuumName: "Robot",
    disposed: false,
    cachedSchedules: [
      { id: "timer-1", enabled: false, timer: ["timer-1", "off"] },
    ],
    lastServerTimerSchedules: [
      { id: "timer-1", enabled: false, timer: ["timer-1", "off"] },
    ],
    lastCloudSceneSchedules: [],
    lastScheduleRefreshAt: 0,
    lastFailedRefreshAt: 0,
    consecutiveRefreshFailures: 0,
    nextRefreshAttemptAt: 0,
    scheduleBackoffRandom: () => 0.5,
    accountCoordinator: new ScheduleAccountCoordinator(),
    refreshGeneration: 0,
    writeBatcher: { cancelPending: jest.fn() },
    sync: jest.fn(),
    syncRoutines: jest.fn(),
    waitForScheduleVerification: async () => {},
    waitForScheduleWriteSpacing: async () => {},
  });
});
afterEach(async () => {
  connector.disconnect();
  await jest.advanceTimersByTimeAsync(0);
  jest.clearAllTimers();
  jest.useRealTimers();
});

test.each([true, false])(
  "lost acknowledgement, assignment applied (%s): read confirms it without retry",
  async (enabled) => {
    timers.set("timer-1", !enabled);
    writes.push({ apply: true, reply: false });
    const failures = await run([request(enabled)]);
    expect(failures.size).toBe(0);
    expect(events.map((e) => e.method)).toEqual([
      "upd_server_timer",
      "get_server_timer",
    ]);
    expect(coordinator.cachedSchedules[0].enabled).toBe(enabled);
  }
);

test("lost acknowledgement, assignment not applied: read precedes one fallback and final verification", async () => {
  writes.push({ apply: false, reply: false });
  const failures = await run();
  expect(failures.size).toBe(0);
  expect(events.map((e) => e.method)).toEqual([
    "upd_server_timer",
    "get_server_timer",
    "upd_timer",
    "get_server_timer",
  ]);
});

test("a lost fallback acknowledgement is also read back, without a third write", async () => {
  writes.push({ apply: false, reply: true }, { apply: true, reply: false });
  expect((await run()).size).toBe(0);
  expect(writeEvents()).toHaveLength(2);
  expect(events.at(-1).method).toBe("get_server_timer");
});

test("a fallback that never applies stops after one attempt", async () => {
  writes.push({ apply: false, reply: false }, { apply: false, reply: false });
  expect((await run()).has("timer-1")).toBe(true);
  expect(writeEvents()).toHaveLength(2);
});

test("failed verification cannot use an old matching cache as confirmation", async () => {
  coordinator.cachedSchedules[0].enabled = true;
  coordinator.lastServerTimerSchedules[0].enabled = true;
  writes.push({ apply: false, reply: true });
  reads.push({ silent: true });
  expect((await run()).has("timer-1")).toBe(true);
  expect(writeEvents()).toHaveLength(1);
});

test("failed verification cannot use an old mismatching cache to authorize fallback", async () => {
  writes.push({ apply: false, reply: true });
  reads.push({ silent: true });
  expect((await run()).has("timer-1")).toBe(true);
  expect(writeEvents()).toHaveLength(1);
});

test.each([[], "invalid", [[null]]])(
  "missing or malformed read does not authorize another write: %j",
  async (value) => {
    writes.push({ apply: false, reply: true });
    reads.push({ value });
    expect((await run()).has("timer-1")).toBe(true);
    expect(writeEvents()).toHaveLength(1);
  }
);

test("failure of the unrelated cloud-scene read does not invalidate a fresh timer confirmation", async () => {
  adapter.getCloudScenes.mockRejectedValue(
    new Error("scene service unavailable")
  );
  writes.push({ apply: true, reply: false });
  expect((await run()).size).toBe(0);
  expect(writeEvents()).toHaveLength(1);
});

test("final failed read cannot turn a stale desired state into success", async () => {
  writes.push(
    { apply: false, reply: true },
    {
      apply: true,
      reply: true,
      effect: () => {
        coordinator.lastServerTimerSchedules[0].enabled = true;
      },
    }
  );
  reads.push({}, { silent: true });
  expect((await run()).has("timer-1")).toBe(true);
  expect(writeEvents()).toHaveLength(2);
});

test("an explicit robot refusal is not retried", async () => {
  writes.push({
    apply: false,
    error: { code: -10007, message: "Not FCC robot" },
  });
  expect((await run()).has("timer-1")).toBe(true);
  expect(writeEvents()).toHaveLength(1);
});

test("a request refused before publication is not retried", async () => {
  connector.disconnect();
  expect((await run()).has("timer-1")).toBe(true);
  expect(events).toHaveLength(0);
});

test("a mixed batch retries only the assignment proved not applied", async () => {
  timers.set("timer-2", false);
  writes.push({ apply: true, reply: false }, { apply: false, reply: true });
  expect((await run([request(), request(true, "timer-2")])).size).toBe(0);
  expect(writeEvents().map((e) => [e.method, e.params])).toEqual([
    ["upd_server_timer", [["timer-1", "on"]]],
    ["upd_server_timer", [["timer-2", "on"]]],
    ["upd_timer", ["timer-2", "on"]],
  ]);
});

test("shutdown after an ambiguous write prevents both verification and retry", async () => {
  writes.push({
    apply: false,
    reply: false,
    effect: () => {
      coordinator.disposed = true;
    },
  });
  expect((await run()).has("timer-1")).toBe(true);
  expect(events.map((e) => e.method)).toEqual(["upd_server_timer"]);
});

test("shutdown during verification prevents fallback", async () => {
  writes.push({ apply: false, reply: true });
  reads.push({
    effect: () => {
      coordinator.disposed = true;
    },
  });
  expect((await run()).has("timer-1")).toBe(true);
  expect(writeEvents()).toHaveLength(1);
});

test("verification does not adopt a read started before the write completed", async () => {
  coordinator.refreshInProgress = Promise.resolve({
    success: true,
    hasSchedules: true,
  });
  coordinator.refreshInProgressStartedAt = Date.now();
  coordinator.refreshInProgressHoldsAccountQueue = true;
  writes.push({ apply: true, reply: true });
  expect((await run()).size).toBe(0);
  expect(events.map((e) => e.method)).toEqual([
    "upd_server_timer",
    "get_server_timer",
  ]);
});

test("a real MQTT session replacement is reconciled after its existing recovery finishes", async () => {
  connector.disconnect();
  adapter.config.enableMqttSessionRecovery = true;
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  await connector.initUser({
    rriot: {
      u: "user",
      s: "secret",
      k: "key",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  await jest.advanceTimersByTimeAsync(0);
  writes.push({ apply: true, reply: false, replace: true });
  expect((await run()).size).toBe(0);
  expect(writeEvents()).toHaveLength(1);
  expect(events.at(-1).method).toBe("get_server_timer");
  await Promise.all(replacements);
});
