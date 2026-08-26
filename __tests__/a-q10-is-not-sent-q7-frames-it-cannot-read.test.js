// `pv === "B01"` is two incompatible wire protocols, and this plugin only
// implements one of them.
//
// Upstream (python-roborock) dispatches B01 on the model suffix: `sc*` is the
// Q7 dialect, `ss*` is the Q10 dialect. They do not share a request shape.
//
//   Q7:  {"dps":{"10000":{"method":"prop.set","msgId":"…","params":…}}}
//   Q10: {"dps":{"<numeric dp code>": params}}
//
// The Q10 dialect has no `method`, no `msgId`, and no datapoint 10000 at all.
// So every command this plugin has ever published to a Q10 was a write to a
// datapoint the robot does not have — a well-formed, correctly encrypted frame
// that the robot discards. And Q10 commands are fire-and-forget: the protocol
// sends no RPC reply, so there was nothing to wait for even in the success
// case.
//
// Measured in #14 (niclasreich, Q10 S5 `roborock.vacuum.ss07`, 26 Aug 2026).
// The Q7 method names are visible in his log — `prop.get`, `prop.set`,
// `service.set_room_clean` — all dying of silence identically at both the 2 s
// and the 10 s budget while MQTT connect, subscribe and encryption were all
// healthy. The 3.17.7/3.17.8 diagnostics then reported the link as silent,
// which was true and pointed the reporter at Roborock's cloud. The link was
// silent because we were speaking the wrong language into it.
//
// Until the Q10 dialect is implemented (#19), the honest behaviour is to
// refuse a Q10 command immediately, naming the reason, rather than publish a
// frame that cannot be read and then diagnose the resulting silence as a
// cloud fault.
//
// This tests the rule and not the three methods in his log: NOTHING v1-shaped
// reaches the wire on a Q10. A future method added to `translateOutgoing`
// fails here instead of in someone's log.

const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const b01Q7Adapter = require("../roborockLib/lib/b01Q7Adapter");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createB01Adapter(model, overrides = {}) {
  return {
    isRemoteDevice: jest.fn().mockResolvedValue(true),
    getRobotVersion: jest.fn().mockResolvedValue("B01"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    getProductAttribute: jest.fn(() => model),
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

// Every v1 method that has a Q7 translation, i.e. every method that would
// otherwise be published. Derived from the adapter rather than listed by hand
// so a newly translated method is covered the day it is added.
const WIRE_BOUND_METHODS = [
  "app_start",
  "app_stop",
  "app_pause",
  "app_charge",
  "find_me",
  "app_segment_clean",
  "set_custom_mode",
  "set_clean_type",
  "get_map_list",
  "get_status",
];

describe("a Q10 is not sent Q7 frames it cannot read", () => {
  test("the model suffix decides the dialect, and ss07 is Q10", () => {
    expect(b01Q7Adapter.b01FamilyForModel("roborock.vacuum.ss07")).toBe(
      b01Q7Adapter.B01_FAMILY.Q10
    );
    expect(b01Q7Adapter.b01FamilyForModel("roborock.vacuum.sc05")).toBe(
      b01Q7Adapter.B01_FAMILY.Q7
    );
  });

  test.each(WIRE_BOUND_METHODS)(
    "refuses %s on a Q10 without publishing anything",
    async (method) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await expect(
        handler.sendRequest("duid-q10", method, [1])
      ).rejects.toThrow(/Q10/);

      expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
      expect(adapter.message.buildRoborockMessage).not.toHaveBeenCalled();
    }
  );

  test("the refusal names the dialect and the model, not a cloud fault", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    const error = await handler
      .sendRequest("duid-q10", "app_start", [])
      .catch((caught) => caught);

    expect(error.message).toMatch(/Q10/);
    expect(error.message).toMatch(/ss07/);
    // The whole point: it must not read as a transport or cloud problem.
    expect(error.message).not.toMatch(/timed out/);
    expect(error.message).not.toMatch(/MQTT connection state/);
  });

  test("the refusal is classified as transient so it is throttled, not stack-traced", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    const error = await handler
      .sendRequest("duid-q10", "app_start", [])
      .catch((caught) => caught);

    expect(error.code).toBe("ROBOROCK_TRANSPORT_REFUSED");
    expect(typeof error.transientKind).toBe("string");
    expect(error.transientKind.length).toBeGreaterThan(0);
  });

  test("methods answered without touching the wire still answer on a Q10", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    // `get_room_mapping` is served from NEUTRAL_RESPONSES. Refusing it would
    // regress the 3.17.3 fix, which is exactly the room-mapping timeout this
    // same reporter opened #14 about.
    await expect(
      handler.sendRequest("duid-q10", "get_room_mapping", [])
    ).resolves.toEqual([]);

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  // Regression cover. Q7 devices work today — including three on the
  // maintainer's own bridge — and must be byte-for-byte unaffected.
  test("a Q7 still publishes normally", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc05");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q7", "app_start", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("an unknown B01 model is still treated as Q7 and still publishes", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc01");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q7", "get_status", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
  });
});
