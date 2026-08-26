"use strict";

// The counter that lets a cloud timeout say whether the reply ever arrived is
// only worth anything if the MQTT receiver actually feeds it. A `typeof ===
// "function"` guard around a one-line call is exactly the kind of wiring that
// can silently never fire, so this drives the real `client.on("message")`
// handler rather than the helper it calls.
//
// The rule under test is the placement, not the arithmetic: a message counts
// only once it has been attributed to a robot AND decrypted. An undecodable
// message must NOT count — it already logs at error, and counting it would
// make a broken link look alive, which is the one conclusion the counter
// exists to prevent.

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
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "device-1";

function createAdapter(decoded) {
  return {
    config: {},
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
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

describe("a decoded MQTT message counts toward its robot", () => {
  test("counts a message that was attributed and decrypted", async () => {
    const adapter = createAdapter(protocol102Message());

    await deliver(adapter, `rr/m/o/user-id/mqttuser/${DUID}`);

    expect(adapter.noteCloudMessageReceived).toHaveBeenCalledWith(DUID);
  });

  test("does not count a message that failed to decrypt", async () => {
    // `_decodeMsg` returns null on a CRC mismatch, an unknown protocol version
    // or a missing localKey. A link that delivers only garbage is not a link.
    const adapter = createAdapter(null);

    await deliver(adapter, `rr/m/o/user-id/mqttuser/${DUID}`);

    expect(adapter.noteCloudMessageReceived).not.toHaveBeenCalled();
  });

  test("does not count a message that belongs to no known robot", async () => {
    const adapter = createAdapter(protocol102Message());

    await deliver(adapter, "rr/m/o/user-id/mqttuser/some-other-device");

    expect(adapter.noteCloudMessageReceived).not.toHaveBeenCalled();
    expect(adapter.message._decodeMsg).not.toHaveBeenCalled();
  });

  test("still works for an adapter that cannot count", async () => {
    const adapter = createAdapter(protocol102Message());
    delete adapter.noteCloudMessageReceived;

    await expect(
      deliver(adapter, `rr/m/o/user-id/mqttuser/${DUID}`)
    ).resolves.toBeUndefined();

    expect(adapter.log.error).not.toHaveBeenCalled();
  });
});
