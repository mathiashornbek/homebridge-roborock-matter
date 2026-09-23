"use strict";

// PR 2/4: drive production MQTT events and actual request timeouts into the
// real breaker. Run this same file on PR 1 to demonstrate false breaker opens.
// No fabricated timeout errors and no direct calls to the new policy helper.
const mockHandlers = new Map();
const mockSubscriptions = [];
const mockClient = {
  on: jest.fn((event, handler) => mockHandlers.set(event, handler)),
  subscribe: jest.fn((topic, callback) => mockSubscriptions.push(callback)),
  publish: jest.fn(),
  end: jest.fn(),
  reconnect: jest.fn(),
  removeAllListeners: jest.fn(),
};
jest.mock("mqtt", () => ({ connect: jest.fn(() => mockClient) }));
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const {
  UnansweredMethodBreaker,
  isUnansweredRequest,
} = require("../roborockLib/lib/unansweredMethodBreaker");

let adapter, connector, queue, states, requestId;
const topic = (duid = "robot-a") =>
  `rr/m/o/private-user/private-client/${duid}`;
const snapshot = () =>
  JSON.parse(states.get("MqttSessionDiagnostics")?.val || "{}");
const receive = (decoded, duid = "robot-a") => {
  adapter.message._decodeMsg.mockReturnValue(decoded);
  mockHandlers.get("message")(topic(duid), Buffer.from("encrypted-frame"));
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
  mockSubscriptions.at(-1)(null, [{ topic: "private-topic", qos: 1 }]);
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  jest.clearAllMocks();
  mockHandlers.clear();
  mockSubscriptions.length = 0;
  states = new Map();
  requestId = 0;
  adapter = {
    config: {},
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
  mockHandlers.get("connect")({ sessionPresent: false });
  acknowledge();
});
afterEach(() => {
  connector.disconnect();
  jest.clearAllTimers();
  jest.useRealTimers();
});

let breaker, outcomes;
beforeEach(() => {
  breaker = new UnansweredMethodBreaker();
  outcomes = [];
  adapter.noteRequestUnanswered.mockImplementation((duid, method, error) => {
    outcomes.push({
      duid,
      method,
      error,
      ...breaker.recordFailure(duid, method, error),
    });
  });
  adapter.noteRequestAnswered.mockImplementation((duid, method) =>
    breaker.recordAnswer(duid, method)
  );
});
function govern(duid = "robot-a", method = "get_consumable") {
  breaker.govern(duid, method);
}
async function establishSilence() {
  // Status is never governed, but its genuine cloud timeout is useful evidence.
  await timeout("robot-a", "get_status");
  return timeout("robot-b", "get_status");
}

test("correlated cloud failures do not open per-robot methods after six strikes", async () => {
  govern("robot-a");
  govern("robot-b");
  for (let i = 0; i < 8; i++) {
    await timeout("robot-a", "get_consumable");
    await timeout("robot-b", "get_consumable");
  }
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(false);
  expect(breaker.shouldSkip("robot-b", "get_consumable")).toBe(false);
  expect(outcomes.filter((o) => o.counted)).toHaveLength(1);
  expect(outcomes[1].error.accountSessionWasSilent).toBe(true);
  expect(outcomes[1].error).toMatchObject({
    unansweredRequest: true,
    transportWasUp: true,
  });
  expect(mockClient.publish).toHaveBeenCalledTimes(16);
  expect(mockClient.reconnect).not.toHaveBeenCalled();
  expect(mockClient.end).not.toHaveBeenCalled();
});

test("correlation prevents the sixth count but preserves the five earlier failures", async () => {
  govern();
  for (let i = 0; i < 5; i++) await timeout("robot-a", "get_consumable");
  await timeout("robot-b", "get_status");
  const error = await timeout("robot-a", "get_consumable");
  expect(isUnansweredRequest(error)).toBe(false);
  expect(breaker.entries.get("robot-a:get_consumable").failures).toBe(5);
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(false);
  // A new inbound callback removes the account-wide ambiguity. Counting resumes.
  receive(null, "unknown-robot");
  await timeout("robot-a", "get_consumable");
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(true);
});

test("the suppression uses structured evidence even if the log message changes", async () => {
  const error = await establishSilence();
  expect(error).toBeInstanceOf(Error);
  error.message = "Different human-readable timeout wording";
  expect(isUnansweredRequest(error)).toBe(false);
  // The same actual timeout without the explicit evidence preserves compatibility.
  delete error.accountSessionWasSilent;
  expect(isUnansweredRequest(error)).toBe(true);
});

test("cloud timeouts still reject callers while the breaker ignores them", async () => {
  govern();
  await establishSilence();
  const error = await timeout("robot-a", "get_consumable");
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("Cloud request with id");
  expect(error.message).toContain("timed out after 10 seconds");
  expect(outcomes.at(-1)).toMatchObject({ counted: false, opened: false });
  expect(adapter.pendingRequests.size).toBe(0);
});

test("one genuinely silent robot still opens its method normally", async () => {
  govern();
  for (let i = 0; i < 6; i++) await timeout("robot-a", "get_consumable");
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(true);
  expect(outcomes.filter((o) => o.counted)).toHaveLength(6);
});

test("other inbound traffic prevents account suppression of a silent method", async () => {
  govern();
  for (let i = 0; i < 6; i++) {
    const pending = await startRequest("robot-a", "get_consumable");
    receive(reply(999), "robot-b");
    await jest.advanceTimersByTimeAsync(10_000);
    await pending.result;
  }
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(true);
});

test("local failures still count even while cloud correlation exists", async () => {
  await establishSilence();
  govern();
  adapter.localConnector.isConnected.mockReturnValue(true);
  const error = await timeout("robot-a", "get_consumable");
  expect(error.message).toContain("Local request");
  expect(snapshot().correlatedSilenceObserved).toBe(true);
  expect(isUnansweredRequest(error)).toBe(true);
  expect(outcomes.at(-1).counted).toBe(true);
});

test("an ambiguous cloud write cannot inherit the account observation", async () => {
  await establishSilence();
  const error = await timeout("robot-a", "app_start");
  expect(snapshot().correlatedSilenceObserved).toBe(true);
  expect(isUnansweredRequest(error)).toBe(true);
  expect(error.accountSessionWasSilent).not.toBe(true);
  expect(outcomes.at(-1).counted).toBe(false); // user commands are not governed
});

test("a previous-generation read cannot inherit new-generation silence", async () => {
  govern();
  const old = await startRequest("robot-a", "get_consumable", {
    requestTimeoutMs: 50_000,
  });
  mockHandlers.get("close")();
  mockHandlers.get("connect")({ sessionPresent: false });
  acknowledge();
  await establishSilence();
  await jest.advanceTimersByTimeAsync(30_000);
  const error = await old.result;
  expect(snapshot().correlatedSilenceObserved).toBe(true);
  expect(isUnansweredRequest(error)).toBe(true);
  expect(outcomes.at(-1).counted).toBe(true);
});

test("a read with inbound activity cannot inherit later silence on other reads", async () => {
  govern();
  const pending = await startRequest("robot-a", "get_consumable", {
    requestTimeoutMs: 50_000,
  });
  receive(null, "unknown-robot");
  await establishSilence();
  await jest.advanceTimersByTimeAsync(30_000);
  const error = await pending.result;
  expect(snapshot().correlatedSilenceObserved).toBe(true);
  expect(isUnansweredRequest(error)).toBe(true);
  expect(outcomes.at(-1).counted).toBe(true);
});

test("expired cross-robot evidence allows ordinary counting again", async () => {
  govern();
  await establishSilence();
  await jest.advanceTimersByTimeAsync(60_001);
  const error = await timeout("robot-a", "get_consumable");
  expect(isUnansweredRequest(error)).toBe(true);
  expect(outcomes.at(-1).counted).toBe(true);
});

test("subscription failure cannot create the signal used to suppress counts", async () => {
  govern("robot-a");
  govern("robot-b");
  mockHandlers.get("connect")({ sessionPresent: false });
  mockSubscriptions.at(-1)(null, [{ qos: 128 }]);
  await timeout("robot-a", "get_consumable");
  const error = await timeout("robot-b", "get_consumable");
  expect(connector.isConnected()).toBe(true);
  expect(isUnansweredRequest(error)).toBe(true);
  expect(outcomes.filter((o) => o.counted)).toHaveLength(2);
});

test("missing instrumentation keeps the existing timeout classification", async () => {
  govern();
  adapter.rr_mqtt_connector = {
    isConnected: () => true,
    sendMessage: jest.fn(),
  };
  const error = await timeout("robot-a", "get_consumable");
  expect(isUnansweredRequest(error)).toBe(true);
  expect(outcomes.at(-1).counted).toBe(true);
});

test("a down transport is still excluded without a correlated-silence signal", async () => {
  govern();
  const pending = await startRequest("robot-a", "get_consumable");
  mockHandlers.get("close")();
  await jest.advanceTimersByTimeAsync(10_000);
  const error = await pending.result;
  expect(error.transportWasUp).toBe(false);
  expect(isUnansweredRequest(error)).toBe(false);
  expect(outcomes.at(-1).counted).toBe(false);
});

test("correlated silence does not reopen an already-open breaker", async () => {
  govern();
  for (let i = 0; i < 6; i++) await timeout("robot-a", "get_consumable");
  const before = { ...breaker.entries.get("robot-a:get_consumable") };
  await establishSilence();
  // A direct, otherwise permitted request can still reach the message layer.
  await timeout("robot-a", "get_consumable");
  expect(breaker.entries.get("robot-a:get_consumable")).toEqual(before);
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(true);
});
