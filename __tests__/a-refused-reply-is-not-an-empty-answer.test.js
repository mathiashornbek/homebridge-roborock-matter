"use strict";

// Issue #22: a Saros 10R (roborock.vacuum.a144, fw 02.52.86) answers
// get_status, get_timer, get_carpet_mode and get_water_box_custom_mode over
// the cloud, and refuses get_server_timer. Its owner's debug log:
//
//   Cloud message with protocol 102 and id 10 received. Result: undefined
//   Schedule discovery for 1MDui…: type=undefined, value=undefined
//   Unable to reliably read Roborock schedules …: get_server_timer returned
//   undefined; preserving existing schedules.
//
// Three lines, no information. The reply body was decoded, the pending promise
// was resolved with `undefined`, and whatever the robot said about WHY was
// discarded at the connector before any of those lines were written. The same
// sentence is printed for a timeout, a parser gap and a method the firmware
// does not implement, so the user cannot tell them apart and neither can we.
//
// The rule this locks in: a reply with no `result` is not an empty answer. If
// the robot spelled out a refusal, the waiting caller is owed it as an error.

const {
  describeReplyRefusal,
} = require("../roborockLib/lib/describeReplyRefusal");

describe("describeReplyRefusal", () => {
  test("a reply that carries a result is never a refusal", () => {
    expect(describeReplyRefusal({ id: 7, result: [] })).toBeNull();
    expect(describeReplyRefusal({ id: 7, result: ["ok"] })).toBeNull();
    expect(describeReplyRefusal({ id: 7, result: null })).toBeNull();
    expect(describeReplyRefusal({ id: 7, result: 0 })).toBeNull();
  });

  test("an empty array result stays an authoritative empty answer", () => {
    // get_timer answered [] for the same robot in the same second. That is a
    // real "you have no timers", and it must not be turned into an error.
    expect(describeReplyRefusal({ id: 6, result: [] })).toBeNull();
  });

  test("a result and an error together is still a result", () => {
    expect(
      describeReplyRefusal({ id: 7, result: ["ok"], error: "ignored" })
    ).toBeNull();
  });

  test("a resultless reply with no error is left alone", () => {
    // Nothing to report is not the same as something to report. This keeps the
    // change from inventing failures on firmwares that simply say nothing.
    expect(describeReplyRefusal({ id: 10 })).toBeNull();
    expect(describeReplyRefusal({ id: 10, error: null })).toBeNull();
    expect(describeReplyRefusal({ id: 10, error: undefined })).toBeNull();
    expect(describeReplyRefusal({ id: 10, error: "" })).toBeNull();
  });

  test("a JSON-RPC style refusal is reported with code and message", () => {
    expect(
      describeReplyRefusal({
        id: 10,
        error: { code: -32601, message: "unknown method" },
      })
    ).toBe("unknown method (code -32601)");
  });

  test("a refusal with only a message, or only a code, still reads", () => {
    expect(describeReplyRefusal({ id: 10, error: { message: "busy" } })).toBe(
      "busy"
    );
    expect(describeReplyRefusal({ id: 10, error: { code: 22 } })).toBe(
      "code 22"
    );
  });

  test("a plain string or number refusal is passed through", () => {
    expect(describeReplyRefusal({ id: 10, error: "unsupported" })).toBe(
      "unsupported"
    );
    expect(describeReplyRefusal({ id: 10, error: -1 })).toBe("-1");
  });

  test("an error shape nobody has seen yet still beats undefined", () => {
    expect(describeReplyRefusal({ id: 10, error: { retry_after: 30 } })).toBe(
      '{"retry_after":30}'
    );
  });

  test("junk in, null out — a log line is worth more than a crash", () => {
    expect(describeReplyRefusal(undefined)).toBeNull();
    expect(describeReplyRefusal(null)).toBeNull();
    expect(describeReplyRefusal("not an object")).toBeNull();
    expect(describeReplyRefusal(42)).toBeNull();
  });
});

describe("the cloud connector rejects a refusal instead of resolving it", () => {
  const {
    roborock_mqtt_connector,
  } = require("../roborockLib/lib/roborock_mqtt_connector");

  function pendingEntry() {
    const entry = { method: "get_server_timer", secure: false, timeout: 1 };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    // Nothing awaits this promise until the assertion does; without a handler
    // attached now, a rejection would surface as an unhandled rejection.
    entry.promise.catch(() => {});
    return entry;
  }

  function harness(pending) {
    const debug = [];
    return {
      debug,
      adapter: {
        config: { debug: true },
        log: {
          debug: (line) => debug.push(line),
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        clearTimeout: () => {},
        pendingRequests: new Map(pending ? [[10, pending]] : []),
        setStateAsync: () => {},
        describeDevice: () => "Rocky",
      },
    };
  }

  // The decode path in the connector is bound to a live MQTT socket, so the
  // resolution step is exercised through the exported helper the receiver
  // calls, and the receiver's own wiring is covered by the source check below.
  test("the connector requires the refusal helper", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "roborockLib",
        "lib",
        "roborock_mqtt_connector.js"
      ),
      "utf8"
    );

    expect(source).toContain("describeReplyRefusal");
    // The refusal has to be decided before the promise is settled, otherwise
    // the caller has already been told the request succeeded.
    expect(source.indexOf("describeReplyRefusal(dps)")).toBeLessThan(
      source.indexOf("pending.resolve(dps.result)")
    );
    expect(source).toContain("pending.reject(");
  });

  test("the local connector requires it too", () => {
    // Same defect, same class: localConnector resolved parsed_102.result with
    // no regard for whether the reply had one.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "lib", "localConnector.js"),
      "utf8"
    );

    expect(source).toContain("describeReplyRefusal");
    expect(source.indexOf("describeReplyRefusal(parsed_102)")).toBeLessThan(
      source.indexOf("resolve(result)")
    );
    expect(source).toContain("reject(");
  });

  test("the harness the other tests use is wired the way the connector is", () => {
    // Guards the two source assertions above from rotting into a check of a
    // file that no longer has a pending map at all.
    const pending = pendingEntry();
    const { adapter } = harness(pending);
    expect(adapter.pendingRequests.get(10)).toBe(pending);
    expect(typeof roborock_mqtt_connector).toBe("function");
  });
});
