"use strict";

// Exercise the existing production MQTT callbacks, request timeout, UI route,
// and report builder. No synthetic timeout Error objects or new helper calls:
// this same file runs on v3.33.0 and fails on missing observable evidence.
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
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

test("export records connection generation and actual SUBACK, not merely a socket", () => {
  expect(snapshot()).toMatchObject({
    generation: 1,
    connected: true,
    subscriptionAcknowledged: true,
  });
  mockHandlers.get("close")();
  expect(snapshot()).toMatchObject({
    connected: false,
    subscriptionAcknowledged: false,
  });
  mockHandlers.get("connect")({ sessionPresent: true });
  expect(snapshot()).toMatchObject({
    generation: 2,
    subscriptionAcknowledged: false,
  });
  acknowledge();
  expect(snapshot().subscriptionAcknowledged).toBe(true);
});

test("a late SUBACK cannot describe the next connection as acknowledged", () => {
  const oldCallback = mockSubscriptions.at(-1);
  mockHandlers.get("close")();
  mockHandlers.get("connect")({ sessionPresent: false });
  oldCallback(null, [{ qos: 1 }]);
  expect(snapshot().subscriptionAcknowledged).toBe(false);
  acknowledge();
  expect(snapshot().subscriptionAcknowledged).toBe(true);
});

test.each([new Error("denied"), null])(
  "failed or rejected subscription is recorded (%s)",
  (error) => {
    mockHandlers.get("connect")({ sessionPresent: false });
    mockSubscriptions.at(-1)(error, [{ qos: 128 }]);
    expect(snapshot().subscriptionAcknowledged).toBe(false);
    // Existing upstream send readiness is deliberately unchanged.
    expect(connector.isConnected()).toBe(true);
  }
);

test("raw, attributed, decoded and matched reply ages distinguish delivery stages", async () => {
  await jest.advanceTimersByTimeAsync(30_000);
  receive(reply(77), "unknown-robot");
  expect(snapshot()).toMatchObject({
    lastRawInboundAgeMs: 0,
    lastAttributedInboundAgeMs: null,
    lastDecodedInboundAgeMs: null,
    lastCorrelatedReplyAgeMs: null,
  });
  await jest.advanceTimersByTimeAsync(30_000);
  receive(null);
  expect(snapshot()).toMatchObject({
    lastAttributedInboundAgeMs: 0,
    lastDecodedInboundAgeMs: null,
  });
  await jest.advanceTimersByTimeAsync(30_000);
  receive(reply(77));
  expect(snapshot()).toMatchObject({
    lastDecodedInboundAgeMs: 0,
    lastCorrelatedReplyAgeMs: null,
  });
  const request = await startRequest();
  await jest.advanceTimersByTimeAsync(30_000 - 25_000);
  receive(reply(request.id));
  await request.result;
  // A timeout publishes a fresh snapshot, including the earlier reply's age.
  await timeout("robot-b");
  expect(snapshot().lastCorrelatedReplyAgeMs).toBe(10_000);
});

test("two active silent robots are observed in the production timeout and persisted export", async () => {
  const first = await timeout("robot-a");
  expect(first).toMatchObject({
    unansweredRequest: true,
    transportWasUp: true,
  });
  expect(snapshot()).toMatchObject({
    silentReadRobotCount: 1,
    correlatedSilenceObserved: false,
  });
  const second = await timeout("robot-b");
  expect(snapshot()).toMatchObject({
    silentReadRobotCount: 2,
    correlatedSilenceObserved: true,
  });
  expect(second.message).toContain('"correlatedSilenceObserved":true');
  expect(adapter.noteRequestUnanswered).toHaveBeenCalledWith(
    "robot-b",
    "get_status",
    second
  );
  expect(mockClient.end).not.toHaveBeenCalled();
  expect(mockClient.reconnect).not.toHaveBeenCalled();
});

test("idle cloud time and repeated silence from one robot do not imply account silence", async () => {
  await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  await timeout("robot-a");
  await timeout("robot-a");
  expect(snapshot()).toMatchObject({
    silentReadRobotCount: 1,
    correlatedSilenceObserved: false,
  });
  expect(mockClient.reconnect).not.toHaveBeenCalled();
});

test("any raw MQTT traffic clears correlation even when attribution fails", async () => {
  await timeout("robot-a");
  const pending = await startRequest("robot-b");
  receive(null, "unknown-robot");
  await jest.advanceTimersByTimeAsync(10_000);
  await pending.result;
  expect(snapshot()).toMatchObject({
    silentReadRobotCount: 0,
    correlatedSilenceObserved: false,
  });
});

test("old timeouts expire from the bounded observation window", async () => {
  await timeout("robot-a");
  await jest.advanceTimersByTimeAsync(60_001);
  await timeout("robot-b");
  expect(snapshot()).toMatchObject({
    silentReadRobotCount: 1,
    correlatedSilenceObserved: false,
  });
});

test("an in-flight request from the previous generation cannot seed correlation", async () => {
  const pending = await startRequest("robot-a");
  mockHandlers.get("close")();
  mockHandlers.get("connect")({ sessionPresent: false });
  acknowledge();
  await jest.advanceTimersByTimeAsync(10_000);
  await pending.result;
  await timeout("robot-b");
  expect(snapshot()).toMatchObject({
    generation: 2,
    silentReadRobotCount: 1,
    correlatedSilenceObserved: false,
  });
});

test("a down transport and ambiguous writes do not contribute silent-read evidence", async () => {
  const pending = await startRequest();
  mockHandlers.get("close")();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await pending.result).toMatchObject({ transportWasUp: false });
  expect(snapshot().silentReadRobotCount).toBe(0);
  mockHandlers.get("connect")({ sessionPresent: false });
  acknowledge();
  await timeout("robot-a", "app_start");
  await timeout("robot-b", "app_start");
  expect(snapshot()).toMatchObject({
    silentReadRobotCount: 0,
    correlatedSilenceObserved: false,
  });
});

test("local replies continue and are recorded separately during cloud silence", async () => {
  await timeout("robot-a");
  await timeout("robot-b");
  adapter.localConnector.isConnected.mockReturnValue(true);
  adapter.localConnector.sendMessage.mockImplementation(() => {
    const pending = adapter.pendingRequests.get(requestId);
    clearTimeout(pending.timeout);
    adapter.pendingRequests.delete(requestId);
    pending.resolve({ battery: 80 });
  });
  const request = await startRequest("robot-a", "get_status");
  expect(await request.result).toEqual({ battery: 80 });
  adapter.localConnector.isConnected.mockReturnValue(false);
  await timeout("robot-b");
  expect(snapshot()).toMatchObject({
    lastLocalReplyAgeMs: 10_000,
    lastCorrelatedReplyAgeMs: null,
    correlatedSilenceObserved: true,
  });
});

test("breaker behavior is unchanged even when correlation is observed", async () => {
  const breaker = new UnansweredMethodBreaker();
  for (const duid of ["robot-a", "robot-b"])
    breaker.govern(duid, "get_consumable");
  adapter.noteRequestUnanswered.mockImplementation((duid, method, error) =>
    breaker.recordFailure(duid, method, error)
  );
  for (let i = 0; i < 6; i++) {
    await timeout("robot-a", "get_consumable");
    await timeout("robot-b", "get_consumable");
  }
  expect(snapshot().correlatedSilenceObserved).toBe(true);
  expect(breaker.shouldSkip("robot-a", "get_consumable")).toBe(true);
  expect(breaker.shouldSkip("robot-b", "get_consumable")).toBe(true);
});

test.each(["b01", "b01-map", "secure-ack", "refusal"])(
  "matched %s replies count without altering completion semantics",
  async (kind) => {
    await jest.advanceTimersByTimeAsync(30_000);
    const resolve = jest.fn(),
      reject = jest.fn();
    if (kind === "b01") {
      adapter.pendingRequests.set("7", { resolve, reject });
      receive({
        protocol: 102,
        payload: JSON.stringify({
          dps: { 10001: { msgId: "7", code: 0, data: { status: 1 } } },
        }),
      });
      expect(resolve).toHaveBeenCalled();
    } else if (kind === "b01-map") {
      adapter.pendingB01MapRequests.set("robot-a", { resolve });
      receive({ protocol: 301, payload: Buffer.from("map") });
      expect(resolve).toHaveBeenCalled();
    } else {
      adapter.pendingRequests.set(7, {
        resolve,
        reject,
        secure: kind === "secure-ack",
      });
      if (kind === "secure-ack") {
        receive(reply(7));
        expect(resolve).not.toHaveBeenCalled();
      } else {
        receive({
          protocol: 102,
          payload: JSON.stringify({
            dps: {
              102: JSON.stringify({
                id: 7,
                error: { code: -1, message: "refused" },
              }),
            },
          }),
        });
        expect(reject).toHaveBeenCalled();
      }
    }
    expect(snapshot().lastCorrelatedReplyAgeMs).toBe(0);
  }
);

test("a diagnostics write failure cannot stop a real reply resolving", async () => {
  adapter.setStateAsync.mockImplementation(async (key, value) => {
    if (key === "MqttSessionDiagnostics") throw new Error("disk unavailable");
    states.set(key, value);
  });
  const request = await startRequest();
  await jest.advanceTimersByTimeAsync(1);
  receive(reply(request.id));
  expect(await request.result).toEqual(["ok"]);
  expect(adapter.log.error).not.toHaveBeenCalled();
});

test("the persisted observation reaches the actual UI route and copied report without identities", async () => {
  await timeout("robot-a");
  await timeout("robot-b");
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "mqtt-observation-"));
  try {
    for (const [key, value] of states)
      fs.writeFileSync(
        path.join(storage, `roborock.${key}`),
        JSON.stringify(value)
      );
    fs.writeFileSync(
      path.join(storage, "roborock.HomeData"),
      JSON.stringify({ val: JSON.stringify({ devices: [], products: [] }) })
    );
    const handlers = new Map();
    class UiHost {
      constructor() {
        this.homebridgeStoragePath = storage;
      }
      onRequest(route, handler) {
        handlers.set(route, handler);
      }
      ready() {}
    }
    const filename = path.join(__dirname, "../src/ui/index.ts");
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    const mod = { exports: {} };
    const { createRequire } = require("module");
    const context = {
      module: mod,
      exports: mod.exports,
      require: (specifier) =>
        specifier === "../crypto"
          ? { encryptSession: jest.fn() }
          : createRequire(filename)(specifier),
      __dirname: path.dirname(filename),
      process,
      console,
      Buffer,
    };
    vm.runInNewContext(js, context, { filename });
    new mod.exports.RoborockUiServer(UiHost);
    const result = await handlers.get("/diagnostics/state")();
    expect(result.ok).toBe(true);
    expect(result.mqttSession).toMatchObject({
      generation: 1,
      correlatedSilenceObserved: true,
    });
    const browser = fs.readFileSync(
      path.join(__dirname, "../homebridge-ui/public/index.js"),
      "utf8"
    );
    const from = browser.indexOf("async function buildDiagnosticsReport");
    const to = browser.indexOf("function appendLocalTestReport");
    const ctx = {
      state: {},
      maskIdentifier: (x) => x,
      maskLocalIp: (x) => x,
      maskLocalIpsInText: (x) => x,
      describeSavedCloudOnlyMode: async () => "disabled",
      describeEnabledMatterFeatures: async () => "none",
      appendLocalTestReport: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(browser.slice(from, to), ctx);
    const report = await ctx.buildDiagnosticsReport(result);
    expect(report).toContain('"correlatedSilenceObserved":true');
    expect(report).toContain("ages at capturedAt");
    expect(report).not.toMatch(
      /private-user|private-client|private-secret|private-key|robot-a|robot-b|rr\/m/
    );
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
