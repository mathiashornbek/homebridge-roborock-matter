// A cloud request that times out used to say only that it timed out, and the
// two causes behind it need opposite responses: a reply that never arrived is
// a robot or account that is not answering, while a reply that arrived and was
// not matched is a correlation bug on this side. The plugin already knew which
// one it was — the MQTT receiver attributes every decoded message to a device —
// but the three paths that could have said so all logged at debug.
//
// Measured in #14 (niclasreich, Q10 S5 `roborock.vacuum.ss07`, 26 Aug 2026):
// every prop.get, prop.set and service.set_room_clean timed out while the MQTT
// state read `true`, and the log could not tell silence from an unrecognised
// answer. It cost two round trips with the reporter.

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
    // Fire the timeout immediately: every test here is about what the timeout
    // says, not about how long it waited.
    setTimeout: jest.fn((callback) => setTimeout(callback, 0)),
    clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
    log: createLog(),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    ...overrides,
  };
}

describe("a cloud timeout says whether the reply ever arrived", () => {
  test("names total silence when no message has ever arrived from the robot", async () => {
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(0),
    });

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(
      /No Roborock message has reached the plugin from this robot since startup/
    );
  });

  test("names a live link when messages arrived while the request was pending", async () => {
    let receipts = 4;
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn(() => receipts),
    });
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      // Two robot pushes land while the request is outstanding, and neither is
      // the reply to it.
      receipts += 2;
    });

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(
      /2 Roborock message\(s\) reached the plugin from this robot while the request was pending/
    );
  });

  test("separates a link that went quiet from one that never spoke", async () => {
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(7),
    });

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(
      /No Roborock message reached the plugin from this robot while the request was pending \(7 cloud message\(s\) since startup\)/
    );
  });

  // The total above is only safe to print if the reader knows what it counts.
  // It is incremented in the MQTT receiver alone, so replies that came back on
  // the local socket never appear in it — while the 180 s poll chain a reader
  // would compare it against runs over whichever transport happens to be up.
  //
  // Measured on Mathias' own S8 Pro Ultra (`roborock.vacuum.a70`, 27 Aug 2026
  // 03:18): a single transient cloud timeout reported "(8 since startup)" after
  // 8.5 hours of polling. Compared with the poll rate that reads as a link
  // dropping ~95 % of replies; in fact the robot had been answering locally the
  // whole time and nothing was wrong. A diagnostic that exists to stop wrong
  // conclusions must not hand the reader a ratio that cannot be taken.
  test("says the total counts cloud traffic only, so a locally-answering robot does not read as a dead link", async () => {
    const adapter = createCloudAdapter({
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(8),
    });

    const handler = new messageQueueHandler(adapter);

    const error = await handler.sendRequest("device-1", "get_status", []).then(
      () => null,
      (thrown) => thrown
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/8 cloud message\(s\) since startup/);
    expect(error.message).toMatch(/counts cloud traffic only/);
    expect(error.message).toMatch(/local socket/);
    // The point is the absence of an unqualified figure, not the presence of a
    // caveat next to one: a reader who stops at the parenthesis must not be
    // able to read the old bare total out of it.
    expect(error.message).not.toMatch(/\(8 since startup\)/);
  });

  test("leaves the timeout unchanged when the adapter cannot count receipts", async () => {
    const adapter = createCloudAdapter();
    delete adapter.getCloudMessageReceiptCount;

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(
      /^Cloud request with id 42 with method get_status timed out after 10 seconds\. MQTT connection state: true$/
    );
  });

  test("says nothing extra on a local timeout, where MQTT receipts prove nothing", async () => {
    const adapter = createCloudAdapter({
      isRemoteDevice: jest.fn().mockResolvedValue(false),
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
      getCloudMessageReceiptCount: jest.fn().mockReturnValue(0),
    });

    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow(/Local request with id 42 .* Local connect state: true$/);
  });
});

describe("the adapter counts decoded messages per robot", () => {
  function createApi() {
    return new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-receipts-")),
    });
  }

  test("counts per robot and starts at zero", () => {
    const api = createApi();

    expect(api.getCloudMessageReceiptCount("device-1")).toBe(0);

    api.noteCloudMessageReceived("device-1");
    api.noteCloudMessageReceived("device-1");
    api.noteCloudMessageReceived("device-2");

    expect(api.getCloudMessageReceiptCount("device-1")).toBe(2);
    expect(api.getCloudMessageReceiptCount("device-2")).toBe(1);
    expect(api.getCloudMessageReceiptCount("device-3")).toBe(0);
  });

  test("ignores a missing duid instead of counting it as a robot", () => {
    const api = createApi();

    api.noteCloudMessageReceived(undefined);
    api.noteCloudMessageReceived("");

    expect(api.getCloudMessageReceiptCount(undefined)).toBe(0);
    expect(api.getCloudMessageReceiptCount("")).toBe(0);
  });
});
