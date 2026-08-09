"use strict";

// Roborock answers an ordinary cloud command on protocol 102 with the array
// ["ok"]. The old guard was `if (dps.result != "ok")`, and `["ok"] != "ok"` is
// FALSE — loose equality runs ToPrimitive on the array and compares "ok" to
// "ok". So the branch that was supposed to fire only for secure requests
// (get_map_v1, whose real payload comes on protocol 301) instead swallowed the
// completion of every normal command: app_start, app_stop, app_pause,
// app_charge, set_custom_mode, app_segment_clean. Those sat until the 10 s
// request timeout and then failed in Apple Home — while the robot had already
// done exactly what was asked.

const {
  isOkAcknowledgement,
  shouldResolveOn102,
} = require("../roborockLib/lib/roborock_mqtt_connector");

describe("the JavaScript trap this bug was built on", () => {
  test('["ok"] != "ok" is false, which is why the old guard never fired', () => {
    // Documenting the trap so nobody reintroduces the comparison.
    // eslint-disable-next-line eqeqeq
    expect(["ok"] != "ok").toBe(false);
    expect(["ok"] === "ok").toBe(false);
  });

  test("isOkAcknowledgement recognises both wire shapes", () => {
    expect(isOkAcknowledgement(["ok"])).toBe(true);
    expect(isOkAcknowledgement("ok")).toBe(true);
  });

  test("isOkAcknowledgement does not swallow real payloads", () => {
    expect(isOkAcknowledgement(["ok", "extra"])).toBe(false);
    expect(isOkAcknowledgement([])).toBe(false);
    expect(isOkAcknowledgement([{ battery: 92 }])).toBe(false);
    expect(isOkAcknowledgement("error")).toBe(false);
    expect(isOkAcknowledgement(undefined)).toBe(false);
    expect(isOkAcknowledgement(null)).toBe(false);
    expect(isOkAcknowledgement(0)).toBe(false);
  });
});

describe("protocol 102 resolution", () => {
  const ordinary = { secure: false, method: "app_start" };
  const secure = { secure: true, method: "get_map_v1" };

  test("an ordinary command acknowledged with ['ok'] resolves immediately", () => {
    // This is the regression: before the fix it stayed pending for 10 seconds
    // and then rejected with a timeout.
    expect(shouldResolveOn102(ordinary, ["ok"])).toBe(true);
  });

  test.each([
    ["app_stop", ["ok"]],
    ["app_pause", ["ok"]],
    ["app_charge", ["ok"]],
    ["set_custom_mode", ["ok"]],
    ["app_segment_clean", ["ok"]],
  ])("%s resolves on its acknowledgement", (method, result) => {
    expect(shouldResolveOn102({ secure: false, method }, result)).toBe(true);
  });

  test("a secure request keeps waiting for its protocol 301 payload", () => {
    expect(shouldResolveOn102(secure, ["ok"])).toBe(false);
    expect(shouldResolveOn102(secure, "ok")).toBe(false);
  });

  test("a secure request that fails still resolves instead of hanging", () => {
    // Without this, an error on get_map_v1 waits out the full timeout.
    expect(shouldResolveOn102(secure, ["error"])).toBe(true);
    expect(shouldResolveOn102(secure, [{ code: -1 }])).toBe(true);
  });

  test("reads resolve with their data, secure or not", () => {
    expect(shouldResolveOn102(ordinary, [{ battery: 92 }])).toBe(true);
    expect(shouldResolveOn102(secure, [{ map: "data" }])).toBe(true);
  });

  test("an unknown request id is ignored", () => {
    expect(shouldResolveOn102(undefined, ["ok"])).toBe(false);
    expect(shouldResolveOn102(null, ["ok"])).toBe(false);
  });

  test("a pending entry without an explicit secure flag is treated as ordinary", () => {
    expect(shouldResolveOn102({ method: "app_start" }, ["ok"])).toBe(true);
  });
});

describe("the secure flag reaches the pending request", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "lib", "messageQueueHandler.js"),
    "utf8"
  );

  test("messageQueueHandler stores it so the receiver can tell the two apart", () => {
    // shouldResolveOn102 is only correct if `secure` is actually recorded;
    // without it every secure request would resolve on its ack and the 301
    // payload would arrive with nobody waiting.
    expect(source).toMatch(
      /pendingRequests\.set\(\s*messageID,\s*\{[^}]*\bsecure\b/s
    );
  });
});
