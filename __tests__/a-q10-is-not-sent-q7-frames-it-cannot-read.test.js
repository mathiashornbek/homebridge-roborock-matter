// A Q10 is never sent a Q7 frame — the negative invariant, on its own.
//
// This file was written for 3.18.0, when the honest behaviour on a Q10 was to
// refuse every command rather than publish a Q7 RPC envelope the robot
// discards. 3.19.0 implements the Q10 command dialect, so "nothing reaches the
// wire" is deliberately no longer true and those assertions have gone; the
// positive coverage lives in `a-q10-gets-q10-frames.test.js`.
//
// What survives is the rule that #14 cost three rounds of wrong diagnosis to
// find, and it survives ANY future change to either dialect:
//
//   NOTHING ADDRESSED TO A Q10 MAY EVER CARRY THE Q7 RPC ENVELOPE —
//   no datapoint 10000, no `method`, no `msgId`.
//
// It is kept separate from the positive tests on purpose. Those describe the
// commands implemented today and will be edited every time one is added; this
// one describes a boundary that must hold even for a command nobody has
// written yet, so it is checked against the whole method surface rather than a
// list. A Q10 discards a datapoint-10000 write silently, so a regression here
// does not fail — it reappears as "the Roborock cloud has gone quiet".

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

// Every v1 method the plugin has any B01 handling for at all, whether it ends
// up published, refused or answered neutrally. Deliberately a superset: the
// invariant is about what a Q10 must never receive, so a method that is not
// wire-bound today but becomes so tomorrow is already covered.
const EVERY_B01_METHOD = [
  "app_start",
  "app_stop",
  "app_pause",
  "app_charge",
  "app_start_collect_dust",
  "find_me",
  "app_segment_clean",
  "app_segment_clean_by_ids",
  "set_custom_mode",
  "set_clean_type",
  "set_water_box_custom_mode",
  "get_map_list",
  "get_status",
  "get_prop",
  "get_room_mapping",
  "get_network_info",
  "get_consumable",
  "get_server_timer",
  "get_multi_maps_list",
  "get_clean_summary",
  "get_carpet_mode",
  "get_custom_mode",
];

describe("a Q10 is not sent Q7 frames it cannot read", () => {
  // A "for every send, the shape is X" rule is vacuously true when nothing is
  // ever sent — and that is not hypothetical: run this file against 3.18.0,
  // where every Q10 command was refused, and all of it passes while proving
  // nothing. This guard fails the moment the file stops exercising a real
  // send, so a future change that quietly stops publishing on a Q10 cannot
  // leave the invariant looking checked.
  test("the invariant is checked against real sends, not an empty set", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    for (const method of EVERY_B01_METHOD) {
      await handler
        .sendRequest("duid-q10", method, { segments: [9] })
        .catch(() => undefined);
    }

    expect(
      adapter.rr_mqtt_connector.sendMessage.mock.calls.length
    ).toBeGreaterThan(0);
    expect(adapter.message.buildPayload.mock.calls.length).toBeGreaterThan(0);
  });

  test.each(EVERY_B01_METHOD)(
    "%s never reaches a Q10 as a Q7 envelope",
    async (method) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      // The outcome does not matter here — published, refused or answered
      // neutrally are all acceptable. What is asserted is the shape of
      // anything that did go out.
      await handler
        .sendRequest("duid-q10", method, { segments: [9] })
        .catch(() => undefined);

      for (const call of adapter.message.buildPayload.mock.calls) {
        const [, , , sentMethod, , , , options] = call;
        const dps = options?.b01Q10Dps;

        // Something was built for a Q10, so it must be a datapoint write.
        expect(dps).toBeTruthy();
        expect(dps).not.toHaveProperty("10000");
        expect(JSON.stringify(dps)).not.toMatch(/"(method|msgId)"/);
        // And it must not be carrying a Q7 method name alongside it.
        expect(sentMethod).not.toMatch(/^(prop|service)\./);
      }
    }
  );

  test("the Q7 method names from the #14 log can no longer reach a Q10", async () => {
    // `prop.get`, `prop.set` and `service.set_room_clean` are the three names
    // visible in niclasreich's log, all dying of silence. They are Q7 names,
    // and the robot never understood one of them.
    const q7Names = new Set(["prop.get", "prop.set", "service.set_room_clean"]);

    for (const method of EVERY_B01_METHOD) {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await handler.sendRequest("duid-q10", method, []).catch(() => undefined);

      for (const call of adapter.message.buildPayload.mock.calls) {
        expect(q7Names.has(call[3])).toBe(false);
      }
    }
  });

  test("the model suffix decides the dialect, and ss07 is Q10", () => {
    expect(b01Q7Adapter.b01FamilyForModel("roborock.vacuum.ss07")).toBe(
      b01Q7Adapter.B01_FAMILY.Q10
    );
    expect(b01Q7Adapter.b01FamilyForModel("roborock.vacuum.sc05")).toBe(
      b01Q7Adapter.B01_FAMILY.Q7
    );
  });

  // Regression cover, and the reason this whole split is cautious: Q7 works,
  // three of them are on the maintainer's own bridge, and the Q7 envelope must
  // keep going out exactly as it did.
  test.each(["roborock.vacuum.sc05", "roborock.vacuum.sc01"])(
    "%s still publishes, and never as a datapoint write",
    async (model) => {
      const adapter = createB01Adapter(model);
      const handler = new messageQueueHandler(adapter);

      await expect(
        handler.sendRequest("duid-q7", "app_start", [])
      ).rejects.toThrow(/timed out/);

      expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
      const [, , , sentMethod, , , , options] =
        adapter.message.buildPayload.mock.calls.at(-1);
      expect(sentMethod).toBe("service.set_room_clean");
      expect(options?.b01Q10Dps).toBeUndefined();
    }
  );

  test("an unrecognised B01 model is still treated as Q7", async () => {
    // Q7 is the safe default: it is what every B01 device was treated as
    // before the split, so an unknown model cannot be made worse by it.
    const adapter = createB01Adapter("roborock.vacuum.zz99");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-unknown", "get_status", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
  });
});
