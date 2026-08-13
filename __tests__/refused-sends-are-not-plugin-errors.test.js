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

/**
 * Every refusal `sendRequest` can reject with, as {kind, message}.
 *
 * The rule used to read the reason back out of the prose, and the classifier
 * did the same — so making the messages readable in 3.6.0 silently turned a
 * calm transport condition back into an error with a stack trace once per
 * poll. The reason now travels on the error as `transientKind`, and this
 * extractor reads the tag rather than the sentence. A refusal that rejects
 * with a bare `new Error` is a finding, not a message to classify.
 */
function collectRefusals() {
  const source = fs.readFileSync(MESSAGE_QUEUE_HANDLER_SOURCE, "utf8");
  const tagged = /reject\(\s*refusal\(\s*"([^"]+)",\s*`([^`]*)`/g;
  const refusals = [];
  let match;

  while ((match = tagged.exec(source)) !== null) {
    refusals.push({ kind: match[1], message: renderTemplate(match[2]) });
  }

  return refusals;
}

/** Refusals that still reject with a plain Error, i.e. carry no reason. */
function collectUntaggedRejections() {
  const source = fs.readFileSync(MESSAGE_QUEUE_HANDLER_SOURCE, "utf8");
  const bare = /reject\(\s*new Error\(\s*`([^`]*)`/g;
  const found = [];
  let match;

  while ((match = bare.exec(source)) !== null) {
    found.push(renderTemplate(match[1]));
  }

  return found;
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
  test("the source actually yields the refusals this rule guards", () => {
    // Guards the extraction itself: if the shape of the source changes so the
    // regex finds nothing, the rules below would pass vacuously.
    expect(collectRefusals().length).toBeGreaterThanOrEqual(3);
  });

  test.each(collectUntaggedRejections())(
    "an untagged rejection is still classifiable from its prose: %s",
    (message) => {
      // Tagging is the mechanism now, but anything that still rejects with a
      // plain Error — the timeouts do — must remain recognisable, or it goes
      // back to being logged as a plugin error with a stack once per poll.
      const api = createRoborock();

      expect(api.getTransientErrorKind(message)).not.toBeNull();
    }
  );

  test.each(collectRefusals().map((r) => [r.kind, r.message]))(
    "the %s refusal carries its reason and reads as a sentence: %s",
    (kind, message) => {
      expect(kind).toBeTruthy();
      expect(message).toMatch(/\.$/);
    }
  );

  test.each(collectRefusals().map((r) => [r.kind, r.message]))(
    "a %s refusal is logged calmly, not as a plugin error: %s",
    (kind, message) => {
      const api = createRoborock();
      const error = new Error(message);
      error.code = "ROBOROCK_TRANSPORT_REFUSED";
      error.transientKind = kind;

      api.catchError(error, "get_status", "device-1");

      // The whole point: no stack, no error level, for a decision the plugin
      // made on purpose and already explained at debug where it made it.
      expect(api.log.error).not.toHaveBeenCalled();
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
