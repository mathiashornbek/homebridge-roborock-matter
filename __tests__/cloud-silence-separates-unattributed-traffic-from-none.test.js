"use strict";

// 3.17.7 taught a cloud timeout to say whether the reply ever arrived, and the
// sentence it produces when the per-robot counter is zero overclaims:
//
//   "...so the reply never arrived rather than arriving unrecognised."
//
// That conclusion is only sound if every inbound frame either counts or is
// loudly logged. It is not. The receiver drops a message BEFORE the counter in
// `client.on("message")` whenever `resolveDuidFromTopic` matches no known
// robot, and that path logs at debug and increments nothing. A reply arriving
// on a topic we cannot attribute is *exactly* "arriving unrecognised" — the
// one case the sentence rules out.
//
// Measured in #14 (niclasreich, Q10 S5 `roborock.vacuum.ss07`, 26 Aug 2026):
// he updated to 3.17.7, read that sentence, and concluded the robot never
// answers. It may well not — but his log cannot support that yet, and he is
// the only Q10 in the field, so a wrong conclusion here costs the diagnosis.
//
// The rule under test: when nothing has been attributed to the robot, the
// timeout must distinguish "nothing arrived on any topic" from "frames arrived
// that we failed to attribute", and must not claim the former when it cannot
// tell. Decode failures are deliberately NOT part of this: they already log at
// error (or warn once for a missing localKey), so they are visible.

const mockCapturedHandlers = new Map();

jest.mock("mqtt", () => ({
  connect: jest.fn(() => ({
    on: (event, handler) => {
      mockCapturedHandlers.set(event, handler);
    },
    subscribe: jest.fn(),
    end: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
}));

const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const { Roborock } = require("../roborockLib/roborockAPI");

const DUID = "device-1";

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createCloudAdapter(overrides = {}) {
  return {
    isRemoteDevice: jest.fn().mockResolvedValue(true),
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    rr_mqtt_connector: {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn(),
    },
    config: {},
    localConnector: {
      isConnected: jest.fn().mockReturnValue(false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      buildPayload: jest.fn().mockResolvedValue("payload"),
      buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("message")),
    },
    getRequestId: jest.fn().mockReturnValue(42),
    pendingRequests: new Map(),
    setTimeout: jest.fn((callback) => setTimeout(callback, 0)),
    clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
    log: createLog(),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    ...overrides,
  };
}

function createReceiverAdapter(decoded) {
  return {
    config: {},
    log: createLog(),
    localKeys: new Map([[DUID, "local-key"]]),
    devices: [{ duid: DUID }],
    pendingRequests: new Map(),
    setTimeout: jest.fn(),
    clearTimeout: jest.fn(),
    setStateAsync: jest.fn(),
    message: {
      _decodeMsg: jest.fn(() => decoded),
    },
    noteCloudMessageReceived: jest.fn(),
    noteUnattributedCloudMessage: jest.fn(),
  };
}

async function deliver(adapter, topic) {
  mockCapturedHandlers.clear();
  const connector = new roborock_mqtt_connector(adapter);
  await connector.initUser({
    rriot: {
      u: "user-id",
      k: "key",
      s: "secret",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Message();

  const handler = mockCapturedHandlers.get("message");
  expect(typeof handler).toBe("function");
  handler(topic, Buffer.from("raw"));
}

function protocol102Message() {
  return {
    protocol: 102,
    payload: JSON.stringify({
      dps: { 102: JSON.stringify({ id: 7, result: ["ok"] }) },
    }),
  };
}

describe("cloud silence separates unattributed traffic from none", () => {
  test("names unattributed frames as a fault on this side", async () => {
    // The link is demonstrably delivering; we are the ones dropping it. This
    // is the branch that would change #14 from "Roborock's problem" into
    // "ours", so it has to be unmistakable in the text.
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(0),
      getUnattributedCloudMessageCount: jest.fn().mockReturnValue(3),
    });

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(
      /3 message\(s\) arrived on a topic matching no known robot/
    );
  });

  test("states total MQTT silence only when nothing arrived on any topic", async () => {
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(0),
      getUnattributedCloudMessageCount: jest.fn().mockReturnValue(0),
    });

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(/nothing is coming back over MQTT at all/);
  });

  test("does not claim the reply never arrived when it cannot tell", async () => {
    // The 3.17.7 overclaim, pinned. An adapter with no unattributed counter
    // knows strictly less, so it must state the observation and stop there.
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(0),
    });
    delete adapter.getUnattributedCloudMessageCount;

    const handler = new messageQueueHandler(adapter);

    const error = await handler
      .sendRequest("device-1", "get_status", [])
      .catch((reason) => reason);

    expect(error.message).toMatch(
      /No Roborock message has reached the plugin from this robot since startup/
    );
    expect(error.message).not.toMatch(/rather than arriving unrecognised/);
  });

  test("counts a frame the receiver could not attribute to any robot", async () => {
    const adapter = createReceiverAdapter(protocol102Message());

    await deliver(adapter, "rr/m/o/user-id/mqttuser/some-other-device");

    expect(adapter.noteUnattributedCloudMessage).toHaveBeenCalledTimes(1);
    expect(adapter.noteCloudMessageReceived).not.toHaveBeenCalled();
  });

  test("does not count an attributed frame as unattributed", async () => {
    const adapter = createReceiverAdapter(protocol102Message());

    await deliver(adapter, `rr/m/o/user-id/mqttuser/${DUID}`);

    expect(adapter.noteUnattributedCloudMessage).not.toHaveBeenCalled();
    expect(adapter.noteCloudMessageReceived).toHaveBeenCalledWith(DUID);
  });

  test("still delivers for an adapter that cannot count unattributed frames", async () => {
    const adapter = createReceiverAdapter(protocol102Message());
    delete adapter.noteUnattributedCloudMessage;

    await expect(
      deliver(adapter, "rr/m/o/user-id/mqttuser/some-other-device")
    ).resolves.toBeUndefined();

    expect(adapter.log.error).not.toHaveBeenCalled();
  });

  test("the API counts unattributed frames account-wide, not per robot", async () => {
    // Attribution failed, so there is no robot to attribute it to. The count
    // is deliberately a single account-level number.
    const api = Object.create(Roborock.prototype);

    expect(api.getUnattributedCloudMessageCount()).toBe(0);

    api.noteUnattributedCloudMessage("rr/m/o/user-id/mqttuser/unknown-a");
    api.noteUnattributedCloudMessage("rr/m/o/user-id/mqttuser/unknown-b");

    expect(api.getUnattributedCloudMessageCount()).toBe(2);
  });
});
