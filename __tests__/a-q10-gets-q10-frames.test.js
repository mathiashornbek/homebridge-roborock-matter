// A Q10 gets Q10 frames.
//
// 3.18.0 stopped this plugin publishing Q7 RPC envelopes to a Q10, which the
// robot discards, and refused instead. Refusing is honest but it is not a
// working robot: on a Q10 every command from Apple Home still went nowhere.
// This is the command half of #19 — the dialect the Q10 actually speaks.
//
//   Q7:  {"dps":{"10000":{"method":"prop.set","msgId":"…","params":…}}}
//   Q10: {"dps":{"201":1}}
//
// Two properties of the dialect drive every test below.
//
// 1. IT ANSWERS NOTHING. Q10 commands are fire-and-forget; the protocol
//    defines no RPC reply, and upstream's channel returns None. So a Q10
//    request must NOT register a pending request and must NOT arm a timeout —
//    a timeout on a dialect that never replies is guaranteed to fire, which is
//    precisely the false "the cloud is silent" diagnosis #14 chased for three
//    rounds.
//
// 2. THEREFORE READS CANNOT BE SERVED. `get_status`, `get_map_list` and
//    `get_prop` stay refused. Translating a read would resolve the caller with
//    a value the robot never sent, and `mapStatusToV1` would then publish that
//    non-answer to Apple Home as the robot's state. Status on a Q10 keeps
//    coming from home data over HTTPS, a separate transport measured working
//    in #14. Reading state from pushed datapoint updates is the other half of
//    #19.
//
// Every datapoint code asserted here is upstream's, from
// python-roborock's `b01_q10_code_mappings.py` and `q10/vacuum.py`, where the
// docstrings mark them verified live against ss07 hardware. NOTHING here is
// verified against a Q10 by this project — there is no Q10 on hand. That is
// why the Q7 regression block at the bottom exists and why this ships on the
// beta channel first.

const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const b01Q7Adapter = require("../roborockLib/lib/b01Q7Adapter");
const b01Q10Adapter = require("../roborockLib/lib/b01Q10Adapter");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// Records what buildPayload was asked to build, so the wire shape can be
// asserted without reimplementing the encoder in the test.
function createB01Adapter(model, overrides = {}) {
  const buildPayload = jest.fn(
    async (duid, protocol, messageID, method, params, secure, photo, options) =>
      JSON.stringify(
        options && options.b01Q10Dps
          ? { dps: options.b01Q10Dps }
          : {
              dps: {
                10000: {
                  method,
                  msgId: String(messageID),
                  params: params ?? [],
                },
              },
            }
      )
  );

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
      buildPayload,
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

/** The dps object the adapter was asked to publish, parsed off buildPayload. */
function publishedDps(adapter) {
  const call = adapter.message.buildPayload.mock.calls.at(-1);
  return call?.[7]?.b01Q10Dps ?? null;
}

// The command surface, with the exact upstream payload for each. Table-driven
// so a mapping added to the adapter without a verified payload fails here
// rather than in a stranger's robot.
const Q10_COMMANDS = [
  ["app_start", [], { 201: 1 }],
  ["app_stop", [], { 206: 0 }],
  ["app_pause", [], { 204: 0 }],
  ["app_charge", [], { 202: 5 }],
  ["app_start_collect_dust", [], { 203: 2 }],
  [
    "app_segment_clean_by_ids",
    { segments: [9, 11] },
    { 201: { cmd: 2, clean_paramters: [9, 11] } },
  ],
  ["set_custom_mode", [104], { 123: 4 }],
  ["set_clean_type", [1], { 137: 3 }],
];

// Reads. The dialect never answers, so these must stay refused.
const Q10_UNANSWERABLE = ["get_status", "get_map_list", "get_prop", "find_me"];

describe("a Q10 gets Q10 frames", () => {
  test.each(Q10_COMMANDS)(
    "%s publishes its Q10 datapoint write",
    async (method, params, expectedDps) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await expect(
        handler.sendRequest("duid-q10", method, params)
      ).resolves.toEqual(["ok"]);

      expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
      expect(publishedDps(adapter)).toEqual(expectedDps);
    }
  );

  test("no Q10 frame carries a method, a msgId or datapoint 10000", async () => {
    for (const [method, params] of Q10_COMMANDS) {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await handler.sendRequest("duid-q10", method, params);

      const dps = publishedDps(adapter);
      expect(Object.keys(dps)).toHaveLength(1);
      expect(dps).not.toHaveProperty("10000");
      expect(JSON.stringify(dps)).not.toMatch(/"(method|msgId)"/);
    }
  });

  test("a command resolves on publish, with no pending request and no timeout", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await handler.sendRequest("duid-q10", "app_start", []);

    // A timeout on a dialect that never replies always fires. Arming one is
    // how a working command becomes a reported cloud fault.
    expect(adapter.setTimeout).not.toHaveBeenCalled();
    expect(adapter.pendingRequests.size).toBe(0);
  });

  test("the log says the command was published, not acknowledged", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await handler.sendRequest("duid-q10", "app_start", []);

    const said = adapter.log.debug.mock.calls.flat().join(" ");
    expect(said).toMatch(/fire-and-forget/i);
  });

  test.each(Q10_UNANSWERABLE)(
    "%s is still refused on a Q10, because the dialect answers nothing",
    async (method) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await expect(handler.sendRequest("duid-q10", method, [])).rejects.toThrow(
        /Q10/
      );

      expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
    }
  );

  // This test asserted `ROBOROCK_TRANSPORT_REFUSED` until 3.19.2. It was not
  // wrong about the code; the code itself was the defect. Shaped as a
  // transport fault, the refusal missed `catchError`'s calm branch and every
  // caller that reached it printed `Failed to execute …` on warn — which is
  // what 3.19.0 and 3.19.1 each gated one caller at a time. The dialect
  // having no equivalent for a read is a capability fact, so it now carries
  // the unsupported code and is calm by construction. The intent of this test
  // is unchanged and its two message assertions are untouched; only the
  // mechanism it checks got stronger. Full contract, including the guard that
  // genuine transport refusals still warn:
  // __tests__/a-q10-read-refusal-is-calm-by-construction.test.js
  test("a refusal is a capability fact, so it is calm rather than stack-traced", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    const error = await handler
      .sendRequest("duid-q10", "get_status", [])
      .catch((caught) => caught);

    expect(error.code).toBe("B01_METHOD_UNSUPPORTED");
    expect(error.message).not.toMatch(/timed out/);
    expect(error.message).not.toMatch(/MQTT connection state/);
  });

  test("a segment clean with no rooms is refused rather than sent empty", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q10", "app_segment_clean_by_ids", {
        segments: [],
      })
    ).rejects.toThrow(/Q10/);

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  test("methods answered without touching the wire still answer on a Q10", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    // Served from NEUTRAL_RESPONSES. Refusing it would regress the 3.17.3
    // room-mapping fix, which is the timeout this same reporter opened #14
    // about.
    await expect(
      handler.sendRequest("duid-q10", "get_room_mapping", [])
    ).resolves.toEqual([]);

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  describe("the clean-type tables are not interchangeable", () => {
    // The two families' clean-type numbers overlap, so using the wrong table
    // does not throw — it mops when it was asked to vacuum.
    test("Matter vacuum is 0 on a Q7 and 2 on a Q10", () => {
      expect(b01Q10Adapter.MATTER_TO_Q10_CLEAN_TYPE[0]).toBe(2);
      expect(b01Q10Adapter.translateOutgoing("set_clean_type", [0])).toEqual({
        dp: 137,
        params: 2,
      });
      expect(b01Q7Adapter.translateOutgoing("set_clean_type", [0])).toEqual({
        method: "prop.set",
        params: { mode: 0 },
      });
    });

    test("the Q10 mapping round-trips", () => {
      for (const matter of [0, 1, 2]) {
        const q10 = b01Q10Adapter.MATTER_TO_Q10_CLEAN_TYPE[matter];
        expect(b01Q10Adapter.Q10_CLEAN_TYPE_TO_MATTER[q10]).toBe(matter);
      }
    });
  });

  test("Max+ suction is 8 on a Q10 and 5 on a Q7", () => {
    expect(b01Q10Adapter.translateOutgoing("set_custom_mode", [108])).toEqual({
      dp: 123,
      params: 8,
    });
    expect(b01Q7Adapter.translateOutgoing("set_custom_mode", [108])).toEqual({
      method: "prop.set",
      params: { wind: 5 },
    });
  });

  test("a falsy datapoint value survives encoding", () => {
    // pause/resume/stop all send 0. Collapsing it to {} the way a naive
    // `params || {}` would is a silent no-op on the robot.
    expect(b01Q10Adapter.buildDps(204, 0)).toEqual({ 204: 0 });
    expect(b01Q10Adapter.buildDps(204, null)).toEqual({ 204: {} });
  });

  // ---- Regression cover. Q7 works today, including three robots on the
  // maintainer's own bridge, and no Q10 change may touch it. ----

  test("a Q7 still publishes the RPC envelope on datapoint 10000", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc05");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q7", "app_start", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
    // No Q10 options bag reached the encoder, so the Q7 branch built the frame.
    expect(publishedDps(adapter)).toBeNull();
  });

  test("a Q7 still arms a timeout and registers a pending request", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc01");
    const handler = new messageQueueHandler(adapter);

    // Awaited before asserting: the timeout is armed several awaits deep, and
    // an un-awaited rejection here leaks into whichever test runs next.
    await expect(
      handler.sendRequest("duid-q7", "get_status", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.setTimeout).toHaveBeenCalled();
    expect(adapter.pendingRequests.size).toBe(0);
  });

  test("a Q7 still translates to Q7 method names", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc05");
    const handler = new messageQueueHandler(adapter);

    await handler
      .sendRequest("duid-q7", "app_start", [])
      .catch(() => undefined);

    const [, , , method] = adapter.message.buildPayload.mock.calls.at(-1);
    expect(method).toBe("service.set_room_clean");
  });

  test("the model suffix still decides the dialect", () => {
    expect(b01Q7Adapter.b01FamilyForModel("roborock.vacuum.ss07")).toBe(
      b01Q7Adapter.B01_FAMILY.Q10
    );
    expect(b01Q7Adapter.b01FamilyForModel("roborock.vacuum.sc05")).toBe(
      b01Q7Adapter.B01_FAMILY.Q7
    );
  });
});
