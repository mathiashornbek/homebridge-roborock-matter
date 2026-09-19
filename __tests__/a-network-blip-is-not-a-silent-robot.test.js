"use strict";

/**
 * 3.30.0 added a register that stops asking a robot a request it never
 * answers, and documented — in the source and in the log line the user
 * reads — that it "never trips on a transport error, because those come back
 * on their own".
 *
 * It did. The exclusion was dead code.
 *
 * `messageQueueHandler` builds the two timeout messages with the connection
 * state interpolated as a BOOLEAN:
 *
 *   `… timed out after 10 seconds. MQTT connection state: ${mqttConnectionState}`
 *   `… timed out after 10 seconds Local connect state: ${localConnectionState}`
 *
 * so a link that was down reads "MQTT connection state: false" — which
 * matches none of EAI_AGAIN / ENOTFOUND / ECONNREFUSED / ECONNRESET /
 * "not connected" / "offline". Every one of those names belongs to an error
 * shape that never contains "timed out after" in the first place, so the
 * first gate had already excluded them and the second gate had nothing left
 * to do.
 *
 * Consequence: a four-minute network blip during a clean produces six
 * consecutive timeouts on a 10-second live-room poll, the breaker opens, and
 * live-room tracking dies for six hours — under a log line telling the user
 * this was "not a connection failure".
 *
 * These tests use the EXACT strings the plugin emits. That is the whole
 * point: the 3.30.0 tests used hand-written messages the code cannot
 * produce, which is why they passed against a broken rule.
 */

const fs = require("fs");
const path = require("path");
const {
  isUnansweredRequest,
  UnansweredMethodBreaker,
} = require("../roborockLib/lib/unansweredMethodBreaker");

/** Built from the real template in messageQueueHandler.js. */
const cloudTimeout = (mqttConnected, tail = "") =>
  new Error(
    `Cloud request with id 4263 with method get_map_v1 timed out after 10 seconds. MQTT connection state: ${mqttConnected}${tail}`
  );

const localTimeout = (localConnected) =>
  new Error(
    `Local request with id 7 with method get_prop timed out after 10 seconds Local connect state: ${localConnected}`
  );

/** The real describeCloudSilence tails, copied from messageQueueHandler.js. */
const SILENCE_LINK_DELIVERING =
  " 3 Roborock message(s) reached the plugin from this robot while the request was pending, so the link is delivering; the reply was either never sent or not recognised.";
const SILENCE_NOTHING_AT_ALL =
  " No Roborock message has reached the plugin from this robot since startup, and none arrived on an unrecognised topic either, so nothing is coming back over MQTT at all.";
const SILENCE_NONE_WHILE_PENDING =
  " No Roborock message reached the plugin from this robot while the request was pending (12 cloud message(s) since startup). That total counts cloud traffic only — replies over the local socket are never counted here — so a low number on a robot that usually answers locally is normal and is not evidence the link is failing.";

describe("a network blip is not a silent robot", () => {
  test("a cloud timeout while MQTT was DOWN does not count", () => {
    expect(isUnansweredRequest(cloudTimeout(false))).toBe(false);
    expect(
      isUnansweredRequest(cloudTimeout(false, SILENCE_NONE_WHILE_PENDING))
    ).toBe(false);
  });

  test("a local timeout while the socket was DOWN does not count", () => {
    expect(isUnansweredRequest(localTimeout(false))).toBe(false);
  });

  test("a timeout while the link was UP does count — that is the robot", () => {
    expect(
      isUnansweredRequest(cloudTimeout(true, SILENCE_NONE_WHILE_PENDING))
    ).toBe(true);
    expect(isUnansweredRequest(localTimeout(true))).toBe(true);
  });

  test("traffic arriving while the request was pending is the strongest yes", () => {
    // The link demonstrably delivers, so silence is the robot's.
    expect(
      isUnansweredRequest(cloudTimeout(true, SILENCE_LINK_DELIVERING))
    ).toBe(true);
  });

  test("'nothing is coming back over MQTT at all' is the link, not the robot", () => {
    // MQTT reports itself connected, but not one message has ever arrived.
    // That is not evidence about this one method.
    expect(
      isUnansweredRequest(cloudTimeout(true, SILENCE_NOTHING_AT_ALL))
    ).toBe(false);
  });

  test("a four-minute outage does not cost six hours of live-room tracking", () => {
    const clock = { now: 1_000_000 };
    const breaker = new UnansweredMethodBreaker({ now: () => clock.now });
    const record = breaker.recordFailure.bind(breaker);
    breaker.recordFailure = (duid, method, error) => {
      breaker.govern(duid, method);
      return record(duid, method, error);
    };

    // 24 attempts at 10-second intervals: four minutes of a dropped link.
    for (let i = 0; i < 24; i += 1) {
      clock.now += 10_000;
      expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(false);
      breaker.recordFailure(
        "duid",
        "get_map_v1",
        cloudTimeout(false, SILENCE_NONE_WHILE_PENDING)
      );
    }

    expect(breaker.describeOpen()).toHaveLength(0);
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(false);
  });

  test("a genuinely silent robot is still caught", () => {
    const clock = { now: 1_000_000 };
    const breaker = new UnansweredMethodBreaker({ now: () => clock.now });
    const record = breaker.recordFailure.bind(breaker);
    breaker.recordFailure = (duid, method, error) => {
      breaker.govern(duid, method);
      return record(duid, method, error);
    };

    for (let i = 0; i < 6; i += 1) {
      clock.now += 10_000;
      breaker.recordFailure(
        "duid",
        "get_map_v1",
        cloudTimeout(true, SILENCE_NONE_WHILE_PENDING)
      );
    }

    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(true);
  });

  test("a blip in the middle of a silent streak does not advance it", () => {
    const clock = { now: 1_000_000 };
    const breaker = new UnansweredMethodBreaker({ now: () => clock.now });
    const record = breaker.recordFailure.bind(breaker);
    breaker.recordFailure = (duid, method, error) => {
      breaker.govern(duid, method);
      return record(duid, method, error);
    };

    for (let i = 0; i < 5; i += 1) {
      clock.now += 10_000;
      breaker.recordFailure("duid", "m", cloudTimeout(true));
    }
    // The link drops. This one is not the robot's fault and must not be the
    // sixth strike.
    clock.now += 10_000;
    breaker.recordFailure("duid", "m", cloudTimeout(false));
    expect(breaker.shouldSkip("duid", "m")).toBe(false);

    clock.now += 10_000;
    breaker.recordFailure("duid", "m", cloudTimeout(true));
    expect(breaker.shouldSkip("duid", "m")).toBe(true);
  });
});

describe("the log line and the rule agree", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
    "utf8"
  );

  test("the give-up line still claims this is not a connection failure", () => {
    // It may claim that only because the rule now actually enforces it.
    expect(source).toMatch(/not a connection failure/);
    const breakerSource = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "roborockLib",
        "lib",
        "unansweredMethodBreaker.js"
      ),
      "utf8"
    );
    expect(breakerSource).toMatch(/connection state\|Local connect state/);
  });
});
