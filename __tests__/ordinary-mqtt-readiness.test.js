"use strict";

// Ordinary MQTT path: real connector and queue with deterministic broker events.
const mockClients = [];
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const handlers = new Map(),
      subscriptions = [];
    const client = {
      handlers,
      subscriptions,
      on: jest.fn((event, handler) => handlers.set(event, handler)),
      subscribe: jest.fn((topic, callback) => {
        if (client.knownTopic) callback(null, []);
        else subscriptions.push(callback);
      }),
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
function acknowledge(granted = [{ qos: 1 }]) {
  const client = mockClients.at(-1);
  client.handlers.get("packetreceive")?.({
    cmd: "suback",
    granted: granted.map((x) => x.qos),
  });
  if (!client.knownTopic) client.subscriptions.at(-1)(null, granted);
  client.knownTopic = granted.every((x) => x.qos < 128);
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  jest.clearAllMocks();
  mockClients.length = 0;
  states = new Map();
  requestId = 0;
  adapter = {
    config: { cloudOnlyMode: true },
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

test("waits for SUBACK before publishing and preserves the whole response budget", async () => {
  const client = mockClients[0];
  client.handlers.get("close")();
  client.handlers.get("connect")({ sessionPresent: false });
  const { result, id } = await startRequest();
  await jest.advanceTimersByTimeAsync(9000);
  expect(client.publish).not.toHaveBeenCalled();
  expect(adapter.pendingRequests.size).toBe(0);
  expect(adapter.noteRequestUnanswered).not.toHaveBeenCalled();
  acknowledge();
  await jest.advanceTimersByTimeAsync(25);
  expect(client.publish).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(9999);
  expect(adapter.pendingRequests.has(id)).toBe(true);
  await jest.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ unansweredRequest: true });
});

test("expired readiness is unsent, never robot silence, and cannot publish later", async () => {
  const client = mockClients[0];
  client.handlers.get("close")();
  const { result } = await startRequest();
  await jest.advanceTimersByTimeAsync(10000);
  expect(await result).toMatchObject({
    code: "MQTT_READINESS_TIMEOUT",
    requestNotSent: true,
    unansweredRequest: false,
  });
  expect(adapter.pendingRequests.size).toBe(0);
  expect(adapter.noteRequestUnanswered).not.toHaveBeenCalled();
  client.handlers.get("connect")({});
  acknowledge();
  await jest.advanceTimersByTimeAsync(25);
  expect(client.publish).not.toHaveBeenCalled();
});

test("disconnect settles all outstanding readiness waits without waiting for the deadline", async () => {
  mockClients[0].handlers.get("close")();
  const { result } = await startRequest();
  connector.disconnect();
  expect(await result).toMatchObject({
    code: "MQTT_SHUTTING_DOWN",
    requestNotSent: true,
  });
  expect(connector.readiness.waiters.size).toBe(0);
});

test("synchronous publication failure leaves no request or response timer", async () => {
  mockClients[0].publish.mockImplementation(() => {
    throw new Error("publish failed");
  });
  const { result } = await startRequest();
  expect((await result).message).toBe("publish failed");
  expect(adapter.pendingRequests.size).toBe(0);
  await jest.advanceTimersByTimeAsync(10000);
  expect(adapter.noteRequestUnanswered).not.toHaveBeenCalled();
});

test("a working local connection bypasses the MQTT readiness wait", async () => {
  adapter.config.cloudOnlyMode = false;
  adapter.localConnector.isConnected.mockReturnValue(true);
  mockClients[0].handlers.get("close")();
  const { result, id } = await startRequest();
  expect(adapter.localConnector.sendMessage).toHaveBeenCalledTimes(1);
  const pending = adapter.pendingRequests.get(id);
  clearTimeout(pending.timeout);
  adapter.pendingRequests.delete(id);
  pending.resolve(["local"]);
  expect(await result).toEqual(["local"]);
});

test("B01 map readiness expiry never starts a pending map request", async () => {
  mockClients[0].handlers.get("close")();
  const result = Roborock.prototype.sendB01MapRequest
    .call(adapter, "robot-a", 0)
    .catch((e) => e);
  await jest.advanceTimersByTimeAsync(10000);
  expect(await result).toMatchObject({
    requestNotSent: true,
    code: "MQTT_READINESS_TIMEOUT",
  });
  expect(adapter.pendingB01MapRequests.size).toBe(0);
  expect(mockClients[0].publish).not.toHaveBeenCalled();
});

test("a local-unavailable request can wait for a briefly disconnected cloud fallback", async () => {
  adapter.config.cloudOnlyMode = false;
  mockClients[0].handlers.get("close")();
  const { result, id } = await startRequest();
  expect(mockClients[0].publish).not.toHaveBeenCalled();
  mockClients[0].handlers.get("connect")({});
  acknowledge();
  await jest.advanceTimersByTimeAsync(25);
  expect(mockClients[0].publish).toHaveBeenCalledTimes(1);
  const pending = adapter.pendingRequests.get(id);
  clearTimeout(pending.timeout);
  adapter.pendingRequests.delete(id);
  pending.resolve(["cloud"]);
  expect(await result).toEqual(["cloud"]);
});
