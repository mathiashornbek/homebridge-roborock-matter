// A Q10 read refusal is calm BY CONSTRUCTION, not by gating each caller.
//
// 3.19.0 gated the status poll for a Q10. 3.19.1 gated the live-room poll,
// which is the same defect one loop further along. Both shipped because the
// refusal the send choke point raises for an untranslatable Q10 read is shaped
// like a TRANSPORT fault, so every caller that reaches it prints
// `Failed to execute …` on warn — a line that tells a user their robot is
// failing when the plugin declined to send by design.
//
// The mechanism, measured rather than assumed:
//
//   * `refusal()` set `code = "ROBOROCK_TRANSPORT_REFUSED"` plus a
//     `transientKind` for every refusal it built.
//   * `catchError`'s calm early exit matches ONLY
//     `code === "B01_METHOD_UNSUPPORTED"`.
//   * So a Q10 read refusal missed the calm branch, picked up the transient
//     path, and came out as `log.warn`.
//
// A Q10 having no equivalent for `get_status` is a CAPABILITY FACT — permanent,
// true for every Q10, and identical in kind to the B01/Q7 unsupported-method
// case that already logs at debug. It is not a transport fault. So the refusal
// now carries the unsupported code and `catchError` is calm without any caller
// having to know.
//
// THE SECOND HALF OF THIS FILE IS THE POINT. Reclassifying too broadly would
// silence genuine transport refusals — an offline robot, a dead cloud link, a
// missing local socket — and those MUST stay warnings, because for those the
// robot really is unreachable and the user really does need to know. Only the
// dialect-capability refusal is reclassified; the three transport refusals are
// pinned here so a future widening of the change fails this file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "q10-calm-")),
  });
}

// A B01 adapter whose transport availability can be posed, so each refusal in
// the choke point can be provoked for real instead of hand-built.
function createB01Adapter(
  model,
  { mqtt = true, local = false, online = true } = {}
) {
  return {
    isRemoteDevice: jest.fn().mockResolvedValue(true),
    getRobotVersion: jest.fn().mockResolvedValue("B01"),
    onlineChecker: jest.fn().mockResolvedValue(online),
    getProductAttribute: jest.fn(() => model),
    rr_mqtt_connector: {
      isConnected: jest.fn().mockReturnValue(mqtt),
      sendMessage: jest.fn(),
    },
    config: {},
    localConnector: {
      isConnected: jest.fn().mockReturnValue(local),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      buildPayload: jest.fn().mockResolvedValue("{}"),
      buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("m")),
    },
    getRequestId: jest.fn().mockReturnValue(42),
    pendingRequests: new Map(),
    setTimeout: jest.fn((callback) => setTimeout(callback, 0)),
    clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
    log: createLog(),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
  };
}

/** The error the real send choke point raises, not a reconstruction of it. */
async function refusalFor(adapter, method, params = []) {
  const handler = new messageQueueHandler(adapter);
  return handler.sendRequest("duid-q10", method, params).then(
    () => {
      throw new Error(`${method} resolved; expected it to be refused`);
    },
    (caught) => caught
  );
}

describe("a Q10 read refusal is calm by construction", () => {
  // The two reads that actually reach the wire on a Q10 today. `get_prop` and
  // `find_me` are refused by the same branch, so they carry the same contract.
  test.each(["get_status", "get_map_list", "get_prop", "find_me"])(
    "%s on a Q10 reaches catchError as debug, never as a warning",
    async (method) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const error = await refusalFor(adapter, method);
      const api = createApi();

      await api.catchError(error, method, "duid-q10", "roborock.vacuum.ss07");

      expect(api.log.warn).not.toHaveBeenCalled();
      expect(api.log.error).not.toHaveBeenCalled();
      expect(api.log.debug).toHaveBeenCalledWith(
        expect.stringContaining("Q10")
      );
    }
  );

  test("the refusal still explains itself and still points at #19", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const error = await refusalFor(adapter, "get_status");

    expect(error.code).toBe("B01_METHOD_UNSUPPORTED");
    expect(error.message).toMatch(/#19/);
    expect(error.message).toMatch(/get_status/);
    // The false diagnosis this whole class produced must not reappear.
    expect(error.message).not.toMatch(/timed out/);
    expect(error.message).not.toMatch(/MQTT connection state/);
  });

  test("no Q10 read reaches the wire, calm logging or not", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    await refusalFor(adapter, "get_status");

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.localConnector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.pendingRequests.size).toBe(0);
  });

  // ---------------------------------------------------------------------
  // The guard: genuine transport refusals must NOT have been swept up.
  // ---------------------------------------------------------------------

  test("an offline robot is still a warning, not debug", async () => {
    const adapter = createB01Adapter("roborock.vacuum.a70", { online: false });
    const error = await refusalFor(adapter, "get_status");
    const api = createApi();

    expect(error.code).toBe("ROBOROCK_TRANSPORT_REFUSED");

    await api.catchError(
      error,
      "get_status",
      "duid-q10",
      "roborock.vacuum.a70"
    );

    expect(api.log.warn).toHaveBeenCalled();
  });

  test("an unavailable cloud link is still a warning, not debug", async () => {
    const adapter = createB01Adapter("roborock.vacuum.a70", { mqtt: false });
    const error = await refusalFor(adapter, "get_status");
    const api = createApi();

    expect(error.code).toBe("ROBOROCK_TRANSPORT_REFUSED");

    await api.catchError(
      error,
      "get_status",
      "duid-q10",
      "roborock.vacuum.a70"
    );

    expect(api.log.warn).toHaveBeenCalled();
  });

  test("a Q7 that stops answering is unaffected by the reclassification", async () => {
    // A classic Q7 translates get_status, so it must pass the choke point and
    // reach the transport rather than being refused for the dialect.
    const adapter = createB01Adapter("roborock.vacuum.a70");
    const handler = new messageQueueHandler(adapter);

    handler.sendRequest("duid-q10", "get_status", []).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalled();
  });
});
