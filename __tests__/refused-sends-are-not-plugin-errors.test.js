const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// `messageQueueHandler.sendRequest` refuses to put a request on the wire when
// the transport it would need is not there: the robot is offline, MQTT is
// down, or the local socket is not connected. Those refusals are deliberate —
// the handler writes its own calm debug line at the refusal site — so they
// describe a transport condition, not a plugin failure.
//
// They arrived at `catchError` unclassified, which meant `log.error` plus a
// full stack trace, once per poll, for as long as the condition lasted. A
// robot that drops off the Roborock cloud overnight therefore filled the log
// with hundreds of stack traces about the plugin correctly declining to send.
//
// The rule is enumerated over the source rather than over the three messages
// that were reported: every message `sendRequest` can reject with must be
// something `getTransientErrorKind` recognises. A refusal path added tomorrow
// fails this test until it is classified.

const MESSAGE_QUEUE_HANDLER_SOURCE = path.join(
  __dirname,
  "..",
  "roborockLib",
  "lib",
  "messageQueueHandler.js"
);

const PLACEHOLDER_VALUES = {
  duid: "device-1",
  method: "get_status",
  messageID: "149",
  timeoutSeconds: "10",
  mqttConnectionState: "true",
  localConnectionState: "true",
};

function renderTemplate(template) {
  return template.replace(/\$\{([^}]*)\}/g, (match, expression) => {
    const key = expression.trim();
    return Object.prototype.hasOwnProperty.call(PLACEHOLDER_VALUES, key)
      ? PLACEHOLDER_VALUES[key]
      : "sample";
  });
}

function collectRejectionMessages() {
  const source = fs.readFileSync(MESSAGE_QUEUE_HANDLER_SOURCE, "utf8");
  const pattern = /reject\(\s*new Error\(\s*`([^`]*)`/g;
  const messages = [];
  let match;

  while ((match = pattern.exec(source)) !== null) {
    messages.push(renderTemplate(match[1]));
  }

  return messages;
}

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock(options = {}) {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-refused-")),
    ...options,
  });
}

const OFFLINE_MESSAGE =
  "Device device-1 is offline. Not sending method get_status request.";
const CLOUD_UNAVAILABLE_MESSAGE =
  "Cloud connection not available. Not sending method get_status request.";
const LOCAL_UNAVAILABLE_MESSAGE =
  "Local connection not available for device-1. Not sending method get_status request.";

describe("every refusal sendRequest can reject with is classified as transient", () => {
  test("the source actually yields the refusal messages this rule guards", () => {
    const messages = collectRejectionMessages();

    // Guards the extraction itself: if the shape of the source changes so the
    // regex finds nothing, the rule below would pass vacuously.
    expect(messages.length).toBeGreaterThanOrEqual(5);
  });

  test.each(collectRejectionMessages())(
    "getTransientErrorKind classifies: %s",
    (message) => {
      const api = createRoborock();

      expect(api.getTransientErrorKind(message)).not.toBeNull();
    }
  );

  test("each refusal reason gets its own throttle bucket", () => {
    const api = createRoborock();
    const kinds = new Set([
      api.getTransientErrorKind(OFFLINE_MESSAGE),
      api.getTransientErrorKind(CLOUD_UNAVAILABLE_MESSAGE),
      api.getTransientErrorKind(LOCAL_UNAVAILABLE_MESSAGE),
    ]);

    // Distinct kinds mean a robot that is offline does not silence a separate
    // MQTT outage for the next six hours.
    expect(kinds.size).toBe(3);
  });
});

describe("a refused send is reported calmly", () => {
  test("an offline robot warns instead of logging a plugin error", async () => {
    const log = createLog();
    const api = createRoborock({ log });

    await api.catchError(
      new Error(OFFLINE_MESSAGE),
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain(
      "Failed to execute get_status on robot device-1 (roborock.vacuum.a144)"
    );
  });

  test("no stack trace is rendered for a refused send", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    const error = new Error(OFFLINE_MESSAGE);

    await api.catchError(
      error,
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );

    const rendered = [...log.warn.mock.calls, ...log.error.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");

    // Stack frames, not the word "at" — the throttle note legitimately says
    // "at most once every ...".
    expect(rendered).not.toMatch(/\n\s+at\s/);
    expect(rendered).not.toContain(".js:");
  });

  test.each([
    ["cloud unavailable", CLOUD_UNAVAILABLE_MESSAGE],
    ["local unavailable", LOCAL_UNAVAILABLE_MESSAGE],
  ])("%s is reported calmly too", async (_label, message) => {
    const log = createLog();
    const api = createRoborock({ log });

    await api.catchError(
      new Error(message),
      "get_consumable",
      "device-1",
      "roborock.vacuum.a144"
    );

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("a robot offline across many polls reports once, then summarises", async () => {
    const log = createLog();
    let now = 1000;
    const api = createRoborock({
      log,
      errorLogThrottleMs: 60 * 1000,
      now: () => now,
    });

    // The shape of skmzwanke's 3:28 AM log: a full poll cycle refused in the
    // same second, then get_status once a minute afterwards.
    for (const attribute of [
      "get_multi_maps_list",
      "get_room_mapping",
      "get_consumable",
      "get_carpet_mode",
      "get_carpet_clean_mode",
      "get_water_box_custom_mode",
    ]) {
      await api.catchError(
        new Error(
          `Device device-1 is offline. Not sending method ${attribute} request.`
        ),
        attribute,
        "device-1",
        "roborock.vacuum.a144"
      );
    }

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Suppressed transient device offline warning")
    );

    now += 60 * 1000 + 1;
    await api.catchError(
      new Error(OFFLINE_MESSAGE),
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toContain("5 similar warning(s) across");
    expect(log.warn.mock.calls[1][0]).toContain(
      "Future transient device offline warnings for this robot"
    );
  });

  test("an offline robot does not suppress a separate cloud outage", async () => {
    const log = createLog();
    const api = createRoborock({ log, errorLogThrottleMs: 60 * 1000 });

    await api.catchError(
      new Error(OFFLINE_MESSAGE),
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );
    await api.catchError(
      new Error(CLOUD_UNAVAILABLE_MESSAGE),
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );

    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("the calm path did not swallow real failures", () => {
  test("an unexpected error is still a plugin error with its stack", async () => {
    const log = createLog();
    const api = createRoborock({ log });

    await api.catchError(
      new Error("boom"),
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  test("a message the handler throws rather than rejects stays an error", async () => {
    const log = createLog();
    const api = createRoborock({ log });

    // `Failed to build Roborock message ...` is thrown, not rejected: it means
    // the plugin could not construct its own request, which is a defect and
    // must not be filed under transport noise.
    await api.catchError(
      new Error(
        "Failed to build Roborock message for method get_status on device-1; the command was not sent."
      ),
      "get_status",
      "device-1",
      "roborock.vacuum.a144"
    );

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
