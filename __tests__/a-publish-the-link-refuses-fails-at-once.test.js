"use strict";

/**
 * A publish mqtt.js refuses fails its request at once, as a refusal (3.39.0).
 *
 * With `queueQoSZero: false` mqtt.js no longer holds a QoS 0 publish made
 * while the link is down; it hands the publish callback "No connection to
 * broker" instead. The link can drop between the connection check and the
 * publish (there are awaits in between), and without the callback the
 * request then waited out its 10 s timeout and was counted as a robot that
 * did not answer. Now it fails at once, with the transport refusal the give-up
 * register never counts.
 */

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "duid-s8";
const brokerRefuses = (duid, message, onNotSent) =>
  onNotSent?.(new Error("No connection to broker"));

test("the real connector hands mqtt.js's refusal to the caller", async () => {
  const connector = new roborock_mqtt_connector({
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  // A real mqtt.js client that never connects (nothing listens on port 1).
  await connector.initUser({
    rriot: { k: "k", u: "u", s: "s", r: { m: "mqtt://127.0.0.1:1" } },
  });
  try {
    // Model the race: readiness was acknowledged just before the socket died.
    const generation = connector.sessionDiagnostics.onConnect();
    connector.sessionDiagnostics.onSubscribe(generation, null, [{ qos: 1 }]);
    const refused = jest.fn();
    connector.sendMessage(DUID, Buffer.from("frame"), refused);
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No connection to broker" })
    );
  } finally {
    connector.disconnect();
  }
});

describe("a cloud request whose publish is refused", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("fails at once as a refusal and leaves no pending entry or timer", async () => {
    const { api } = createRealRoborockOnFakeWire({ transport: "cloud" });
    api.rr_mqtt_connector.sendMessage = jest.fn(brokerRefuses);

    const outcome = await api.messageQueueHandler
      .sendRequest(DUID, "get_prop", ["get_status"])
      .catch((error) => error);

    expect(outcome.code).toBe("ROBOROCK_TRANSPORT_REFUSED");
    expect(outcome.message).toMatch(/was lost before the get_prop request/);
    expect(api.pendingRequests.size).toBe(0);
    // The hourly transport line's own timer is the only one left.
    api.transportTally.flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("is not counted as a silence by the give-up register", async () => {
    const { api } = createRealRoborockOnFakeWire({ transport: "cloud" });
    api.rr_mqtt_connector.sendMessage = jest.fn(brokerRefuses);
    api.unansweredMethods.govern(DUID, "get_map_v1");

    for (let i = 0; i < 8; i += 1) {
      await api.messageQueueHandler
        .sendRequest(DUID, "get_map_v1", [])
        .catch(() => undefined);
    }

    expect(api.unansweredMethods.shouldSkip(DUID, "get_map_v1")).toBe(false);
  });
});

test("a B01 map request whose publish is refused fails at once", async () => {
  jest.useFakeTimers();
  try {
    const { api } = createRealRoborockOnFakeWire({ transport: "cloud" });
    api.rr_mqtt_connector.sendMessage = jest.fn(brokerRefuses);

    const outcome = await api
      .sendB01MapRequest(DUID, 0)
      .catch((error) => error);

    expect(outcome.code).toBe("ROBOROCK_TRANSPORT_REFUSED");
    expect(api.pendingB01MapRequests.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
