"use strict";

// PR 3/4: the same production-event tests run on PR 2 to show the missing
// behavior. Timeouts are emitted by the real request queue, not fabricated.
const mockClients = [];
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const handlers = new Map(),
      subscriptions = [];
    const client = {
      handlers,
      subscriptions,
      on: jest.fn((event, handler) => handlers.set(event, handler)),
      subscribe: jest.fn((topic, callback) => subscriptions.push(callback)),
      publish: jest.fn(),
      end: jest.fn(),
      endAsync: jest.fn(async () => {}),
      reconnect: jest.fn(),
      removeAllListeners: jest.fn(() => handlers.clear()),
    };
    mockClients.push(client);
    return client;
  }),
}));
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const { Roborock } = require("../roborockLib/roborockAPI");
let adapter, connector, queue, states, requestId;
const topic = (duid = "robot-a") =>
  `rr/m/o/private-user/private-client/${duid}`;
const snapshot = () =>
  JSON.parse(states.get("MqttSessionDiagnostics")?.val || "{}");
const receive = (decoded, duid = "robot-a") => {
  adapter.message._decodeMsg.mockReturnValue(decoded);
  mockClients.at(-1).handlers.get("message")(
    topic(duid),
    Buffer.from("encrypted-frame")
  );
};
const reply = (id, result = ["ok"]) => ({
  protocol: 102,
  payload: JSON.stringify({ dps: { 102: JSON.stringify({ id, result }) } }),
});
async function startRequest(
  duid = "robot-a",
  method = "get_status",
  options = {}
) {
  const result = queue
    .sendRequest(duid, method, [], false, false, options)
    .catch((error) => error);
  // Drive the async pre-send lookups; the response timer is the real one.
  await jest.advanceTimersByTimeAsync(0);
  return { result, id: requestId };
}
async function timeout(duid = "robot-a", method = "get_status") {
  const request = await startRequest(duid, method);
  await jest.advanceTimersByTimeAsync(10_000);
  return request.result;
}
function acknowledge() {
  mockClients.at(-1).subscriptions.at(-1)(null, [
    { topic: "private-topic", qos: 1 },
  ]);
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  jest.clearAllMocks();
  mockClients.length = 0;
  states = new Map();
  requestId = 0;
  adapter = {
    config: { enableMqttSessionRecovery: true },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map([
      ["robot-a", "private-key-a"],
      ["robot-b", "private-key-b"],
    ]),
    devices: [{ duid: "robot-a" }, { duid: "robot-b" }],
    pendingRequests: new Map(),
    pendingB01MapRequests: new Map(),
    describeDevice: (duid) => duid,
    catchError: jest.fn(),
    isRemoteDevice: jest.fn(async () => false),
    getRobotVersion: jest.fn(async () => "1.0"),
    onlineChecker: jest.fn(async () => true),
    getRequestId: () => ++requestId,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout,
    setStateAsync: jest.fn(async (key, value) => states.set(key, value)),
    updateTransportDiagnostics: jest.fn(async () => {}),
    noteRequestAnswered: jest.fn(),
    noteRequestUnanswered: jest.fn(),
    localConnector: {
      isConnected: jest.fn(() => false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      _decodeMsg: jest.fn(() => null),
      buildPayload: jest.fn(async () => "payload"),
      buildRoborockMessage: jest.fn(async () => Buffer.from("request")),
    },
  };
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  queue = new messageQueueHandler(adapter);
  await connector.initUser({
    rriot: {
      u: "private-user",
      k: "private-key",
      s: "private-secret",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  mockClients.at(-1).handlers.get("connect")({ sessionPresent: false });
  acknowledge();
});
afterEach(() => {
  connector.disconnect();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function restartWith(config) {
  connector.disconnect();
  mockClients.length = 0;
  adapter.config = config;
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  await connector.initUser({
    rriot: {
      u: "user",
      k: "key",
      s: "secret",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  connectLatest();
}

async function silence() {
  await timeout("robot-a");
  await timeout("robot-b");
  await jest.advanceTimersByTimeAsync(0);
}
function connectLatest(granted = [{ qos: 1 }]) {
  mockClients.at(-1).handlers.get("connect")({ sessionPresent: false });
  mockClients.at(-1).subscriptions.at(-1)(null, granted);
}
async function replacementReady() {
  connectLatest();
  await jest.advanceTimersByTimeAsync(50);
}

test("two robots' actual silent reads create a fresh client without replay", async () => {
  const old = mockClients[0];
  await silence();
  expect(mockClients).toHaveLength(2);
  expect(old.endAsync).toHaveBeenCalledWith(true);
  expect(old.reconnect).not.toHaveBeenCalled();
  expect(mockClients[1].publish).not.toHaveBeenCalled();
  expect(typeof old.handlers.get("error")).toBe("function");
  expect(() =>
    old.handlers.get("error")(new Error("late socket error"))
  ).not.toThrow();
  expect(connector.isConnected()).toBe(false);
  await replacementReady();
  expect(connector.isConnected()).toBe(true);
  expect(snapshot().generation).toBe(2);
});

test("TCP connect alone cannot allow a write before the subscription is acknowledged", async () => {
  adapter.config.cloudOnlyMode = true;
  const client = mockClients[0];
  client.handlers.get("close")();
  client.handlers.get("connect")({ sessionPresent: false });
  const { result } = await startRequest("robot-a", "app_start", {
    preferCloud: true,
  });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await result).toMatchObject({
    requestNotSent: true,
    transientKind: "cloud unavailable",
  });
  expect(client.publish).not.toHaveBeenCalled();
  acknowledge();
  expect(connector.isConnected()).toBe(true);
});

test("a refused SUBACK keeps cloud sends closed", async () => {
  connectLatest([{ qos: 128 }]);
  expect(connector.isConnected()).toBe(false);
});

test("a single robot and write-only silence do not recreate", async () => {
  for (let i = 0; i < 3; i++) await timeout("robot-a");
  await timeout("robot-b", "app_start");
  expect(mockClients).toHaveLength(1);
});

test("raw traffic between robot timeouts prevents recreation", async () => {
  await timeout("robot-a");
  receive(null, "unknown");
  await timeout("robot-b");
  expect(mockClients).toHaveLength(1);
});

test("pending cloud writes reject with an unknown outcome, without replay; local requests survive", async () => {
  await timeout("robot-a");
  const second = await startRequest("robot-b");
  await jest.advanceTimersByTimeAsync(9500);
  const write = await startRequest("robot-a", "app_start");
  adapter.localConnector.isConnected.mockReturnValue(true);
  const local = await startRequest("robot-a", "get_status", {
    preferLocal: true,
  });
  await jest.advanceTimersByTimeAsync(1000);
  await second.result;
  expect(mockClients).toHaveLength(2);
  expect(await write.result).toMatchObject({
    code: "MQTT_SESSION_REPLACED",
    transientKind: "mqtt session replaced",
    unansweredRequest: false,
  });
  expect(adapter.pendingRequests.has(local.id)).toBe(true);
  expect(mockClients).toHaveLength(2);
  expect(mockClients[1].publish).not.toHaveBeenCalled();
  const pending = adapter.pendingRequests.get(local.id);
  clearTimeout(pending.timeout);
  adapter.pendingRequests.delete(local.id);
  pending.resolve(["local answer"]);
  expect(await local.result).toEqual(["local answer"]);
});

test("B01 map requests are also rejected on retirement, never replayed", async () => {
  await timeout("robot-a");
  const second = await startRequest("robot-b");
  await jest.advanceTimersByTimeAsync(9500);
  const map = Roborock.prototype.sendB01MapRequest
    .call(adapter, "robot-a", 0)
    .catch((e) => e);
  await jest.advanceTimersByTimeAsync(1000);
  await second.result;
  expect(mockClients).toHaveLength(2);
  expect(await map).toMatchObject({ code: "MQTT_SESSION_REPLACED" });
  expect(adapter.pendingB01MapRequests.size).toBe(0);
  expect(mockClients[1].publish).not.toHaveBeenCalled();
});

test("a request building its payload is refused if recreation starts before publish", async () => {
  const client = mockClients[0];
  let release;
  adapter.message.buildRoborockMessage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const write = queue
    .sendRequest("robot-a", "app_start", [], false, false)
    .catch((e) => e);
  await jest.advanceTimersByTimeAsync(0);
  const recovery = connector.reconnectClient(true);
  release(Buffer.from("request"));
  await jest.advanceTimersByTimeAsync(0);
  expect(client.publish).not.toHaveBeenCalled();
  expect(await write).toMatchObject({ requestNotSent: true });
  await replacementReady();
  await recovery;
});

test("concurrent health checks create only one replacement", async () => {
  const first = connector.reconnectClient(true);
  const second = connector.reconnectClient(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(mockClients).toHaveLength(2);
  await replacementReady();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
});

test("a successful recreation has a cooldown too", async () => {
  await silence();
  await replacementReady();
  await silence();
  expect(mockClients).toHaveLength(2);
});

test("a dead endAsync and absent SUBACK have bounded deadlines and do not loop", async () => {
  mockClients[0].endAsync.mockImplementation(() => new Promise(() => {}));
  const recovery = connector.reconnectClient(true);
  await jest.advanceTimersByTimeAsync(1999);
  expect(mockClients).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(2);
  expect(mockClients).toHaveLength(2);
  mockClients[1].handlers.get("connect")({ sessionPresent: false });
  await jest.advanceTimersByTimeAsync(20_050);
  expect(await recovery).toBe(false);
  expect(connector.isConnected()).toBe(false);
  await connector.ensureConnected();
  expect(mockClients).toHaveLength(2);
});

test("late retired callbacks cannot change readiness or decode a message", async () => {
  const old = mockClients[0];
  const lateMessage = old.handlers.get("message");
  const lateConnect = old.handlers.get("connect");
  const lateSuback = old.subscriptions[0];
  const recovery = connector.reconnectClient(true);
  await jest.advanceTimersByTimeAsync(0);
  lateConnect({});
  lateSuback(null, [{ qos: 1 }]);
  lateMessage(topic(), Buffer.from("stale"));
  expect(connector.isConnected()).toBe(false);
  expect(adapter.message._decodeMsg).not.toHaveBeenCalled();
  await replacementReady();
  await recovery;
});

test("shutdown during drain prevents any new client", async () => {
  const write = await startRequest("robot-a", "app_start");
  const recovery = connector.reconnectClient(true);
  await jest.advanceTimersByTimeAsync(0);
  connector.disconnect();
  await jest.advanceTimersByTimeAsync(1000);
  expect(await recovery).toBe(false);
  expect(await write.result).toBeInstanceOf(Error);
  expect(mockClients).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("shutdown during readiness closes the candidate and cancels the wait", async () => {
  const recovery = connector.reconnectClient(true);
  await jest.advanceTimersByTimeAsync(0);
  connector.disconnect();
  await jest.advanceTimersByTimeAsync(0);
  expect(await recovery).toBe(false);
  expect(mockClients.at(-1).end).toHaveBeenCalledWith(true);
  expect(jest.getTimerCount()).toBe(0);
});

test("preventive refresh is off even when reactive recovery is enabled", async () => {
  await jest.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
  expect(mockClients).toHaveLength(1);
});

test("the independent preventive control permits an idle four-hour refresh", async () => {
  await restartWith({
    enableMqttSessionRecovery: true,
    enableMqttPreventiveRefresh: true,
  });
  await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(mockClients).toHaveLength(2);
  await replacementReady();
  expect(connector.isConnected()).toBe(true);
});

test("preventive refresh defers for a pending write", async () => {
  await restartWith({
    enableMqttSessionRecovery: true,
    enableMqttPreventiveRefresh: true,
  });
  await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 1000);
  const write = await startRequest("robot-a", "app_start");
  await jest.advanceTimersByTimeAsync(1500);
  expect(mockClients).toHaveLength(1);
  expect(adapter.pendingRequests.has(write.id)).toBe(true);
  receive(reply(write.id));
  expect(await write.result).toEqual(["ok"]);
});

test("recovery remains disabled when the option is absent", async () => {
  connector.disconnect();
  adapter.config = {};
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  await connector.initUser({
    rriot: {
      u: "user",
      k: "key",
      s: "secret",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  connectLatest();
  const count = mockClients.length;
  await silence();
  expect(mockClients).toHaveLength(count);
});

test("preventive refresh cannot turn on recovery by itself", async () => {
  await restartWith({ enableMqttPreventiveRefresh: true });
  await jest.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
  expect(mockClients).toHaveLength(1);
});
