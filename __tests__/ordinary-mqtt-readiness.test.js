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
  expect(adapter.message.buildPayload).not.toHaveBeenCalled();
  expect(adapter.pendingRequests.size).toBe(0);
  expect(adapter.noteRequestUnanswered).not.toHaveBeenCalled();
  acknowledge();
  await jest.advanceTimersByTimeAsync(0);
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
  mockClients.at(-1).handlers.get("connect")({});
  acknowledge();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockClients.every((c) => c.publish.mock.calls.length === 0)).toBe(
    true
  );
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
  await jest.advanceTimersByTimeAsync(0);
  expect(mockClients[0].publish).toHaveBeenCalledTimes(1);
  const pending = adapter.pendingRequests.get(id);
  clearTimeout(pending.timeout);
  adapter.pendingRequests.delete(id);
  pending.resolve(["cloud"]);
  expect(await result).toEqual(["cloud"]);
});

test.each([false, true])(
  "preferCloud uses a working LAN while MQTT awaits readiness (connected=%s)",
  async (connected) => {
    adapter.config.cloudOnlyMode = false;
    adapter.localConnector.isConnected.mockReturnValue(true);
    const client = mockClients[0];
    client.handlers.get("close")();
    if (connected) client.handlers.get("connect")({});
    const { result, id } = await startRequest("robot-a", "app_start", {
      preferCloud: true,
    });
    expect(adapter.localConnector.sendMessage).toHaveBeenCalledTimes(1);
    expect(connector.readiness.waiters.size).toBe(0);
    expect(client.publish).not.toHaveBeenCalled();
    const pending = adapter.pendingRequests.get(id);
    clearTimeout(pending.timeout);
    adapter.pendingRequests.delete(id);
    pending.resolve(["local"]);
    expect(await result).toEqual(["local"]);
  }
);

test("a retried initUser reopens the readiness gate after retiring the previous client", async () => {
  await connector.initUser({
    rriot: { u: "u", k: "k", s: "s", r: { m: "mqtt://fixture.invalid" } },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  const request = await startRequest();
  mockClients.at(-1).handlers.get("connect")({});
  acknowledge();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockClients[0].end).toHaveBeenCalledTimes(1);
  expect(mockClients.at(-1).publish).toHaveBeenCalledTimes(1);
  const pending = adapter.pendingRequests.get(request.id);
  clearTimeout(pending.timeout);
  adapter.pendingRequests.delete(request.id);
  pending.resolve(["ok"]);
  expect(await request.result).toEqual(["ok"]);
});

function installHealthRestart() {
  adapter.cloudSessionHealth = { consecutiveSilences: 0, lastRestartAt: 0 };
  adapter.restartCloudSession =
    Roborock.prototype.restartCloudSession.bind(adapter);
  adapter.noteCloudSilence = Roborock.prototype.noteCloudSilence.bind(adapter);
  return jest.spyOn(connector, "reconnectClient");
}

async function readinessExpiry() {
  const { result } = await startRequest();
  await jest.advanceTimersByTimeAsync(10000);
  expect(await result).toMatchObject({
    code: "MQTT_READINESS_TIMEOUT",
    requestNotSent: true,
    unansweredRequest: false,
  });
}

test.each(["missing", "refused"])(
  "%s SUBACK heals after three unsent expiries with the existing cooldown",
  async (suback) => {
    const restart = installHealthRestart();
    const old = mockClients.at(-1);
    old.handlers.get("connect")({});
    if (suback === "refused") acknowledge([{ qos: 128 }]);
    await readinessExpiry();
    await readinessExpiry();
    expect(restart).not.toHaveBeenCalled();
    await readinessExpiry();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(old.end).toHaveBeenCalledWith(true);
    expect(adapter.pendingRequests.size).toBe(0);
    expect(adapter.noteRequestUnanswered).not.toHaveBeenCalled();
    expect(adapter.cloudSessionHealth.consecutiveSilences).toBe(0);
    expect(mockClients.every((c) => c.publish.mock.calls.length === 0)).toBe(
      true
    );
    await jest.advanceTimersByTimeAsync(10000);
    const fresh = mockClients.at(-1);
    expect(fresh).not.toBe(old);
    fresh.handlers.get("connect")({});
    for (let i = 0; i < 3; i++) await readinessExpiry();
    expect(restart).toHaveBeenCalledTimes(1);
    acknowledge();
    const { result, id } = await startRequest();
    receive(reply(id));
    expect(await result).toEqual(["ok"]);
    expect(fresh.publish).toHaveBeenCalledTimes(1);
  }
);

test("disconnected expiries never count towards a health restart", async () => {
  const restart = installHealthRestart();
  mockClients.at(-1).handlers.get("close")();
  for (let i = 0; i < 4; i++) await readinessExpiry();
  expect(connector.unsubscribedExpiries).toBe(0);
  expect(restart).not.toHaveBeenCalled();
  expect(adapter.cloudSessionHealth.lastRestartAt).toBe(0);
});

test("successful subscription and a disconnected generation reset the readiness streak", async () => {
  const restart = installHealthRestart();
  const client = mockClients.at(-1);
  client.handlers.get("connect")({});
  await readinessExpiry();
  await readinessExpiry();
  expect(connector.unsubscribedExpiries).toBe(2);
  acknowledge();
  expect(connector.unsubscribedExpiries).toBe(0);
  client.handlers.get("connect")({});
  await readinessExpiry();
  expect(restart).not.toHaveBeenCalled();
  client.handlers.get("close")();
  expect(connector.unsubscribedExpiries).toBe(0);
});

test("readiness and published-request silence share one restart cooldown", async () => {
  const restart = installHealthRestart();
  expect(adapter.noteCloudSilence()).toBe(false);
  expect(adapter.noteCloudSilence()).toBe(false);
  expect(adapter.noteCloudSilence()).toBe(true);
  await jest.advanceTimersByTimeAsync(10000);
  mockClients.at(-1).handlers.get("connect")({});
  for (let i = 0; i < 3; i++) await readinessExpiry();
  expect(restart).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
  await readinessExpiry();
  expect(restart).toHaveBeenCalledTimes(2);
});

test("a LAN loss shares the explicit remaining budget with MQTT readiness and its reply", async () => {
  adapter.config.cloudOnlyMode = false;
  adapter.localConnector.isConnected.mockReturnValue(true);
  adapter.localConnector.writeRequest = jest.fn((_duid, _frame, onLost) => {
    setTimeout(() => onLost("socket closed"), 1000);
    return { release: jest.fn(), isUp: () => false };
  });
  connector.reconnectDelayMs = 0;
  mockClients.at(-1).handlers.get("close")();
  await jest.advanceTimersByTimeAsync(0);
  const fresh = mockClients.at(-1);
  fresh.handlers.get("connect")({});
  const { result, id } = await startRequest("robot-a", "get_status", {
    requestTimeoutMs: 10000,
  });
  await jest.advanceTimersByTimeAsync(7000);
  expect(adapter.pendingRequests.size).toBe(0);
  expect(fresh.publish).not.toHaveBeenCalled();
  expect(
    adapter.message.buildPayload.mock.calls.map((args) => args[1])
  ).toEqual([4]);
  acknowledge();
  await jest.advanceTimersByTimeAsync(0);
  expect(fresh.publish).toHaveBeenCalledTimes(1);
  expect(adapter.message.buildRoborockMessage.mock.calls.at(-1)[2]).toBe(
    Math.floor(Date.now() / 1000)
  );
  await jest.advanceTimersByTimeAsync(2999);
  expect(adapter.pendingRequests.has(id)).toBe(true);
  await jest.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({
    unansweredRequest: true,
    transportWasUp: false,
  });
});
