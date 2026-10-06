"use strict";

/**
 * The MQTT restart rule on a session that is delivering (found in review of
 * 3.36.0).
 *
 * `get_map_v1` is secure, so it always goes over MQTT, even for a robot on the
 * LAN. Its reply comes in two parts: a protocol-102 "ok" acknowledgement, and
 * the map on protocol 301. The plugin's own record (unansweredMethodBreaker.js,
 * a-dropped-map-reply-says-so.test.js) has the 301 part going missing on a70
 * and a75 robots — 95 and 40 consecutive timeouts — "while the same robot
 * answers everything else". The 102 acknowledgement keeps arriving: the MQTT
 * receiver decodes it and counts it (noteCloudMessageReceived), but it resolves
 * nothing, so noteCloudReply is never called.
 *
 * A LAN robot sends nothing else over the cloud to reset the count, so three
 * such map timeouts restart a session that is demonstrably delivering frames
 * from this robot, with an info line saying it went unanswered. The breaker
 * allows six in a row before it opens, so this fires at the start of every
 * clean on those robots (subject to the 30-minute cooldown).
 */

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const DUID = "duid-a70";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("map requests whose 102 acknowledgement arrives do not restart the MQTT session", async () => {
  const { api, log } = createRealRoborockOnFakeWire({ transport: "local" });
  api.rr_mqtt_connector.reconnectClient = jest.fn(async () => true);

  for (let i = 0; i < 3; i += 1) {
    const request = api.messageQueueHandler
      .sendRequest(DUID, "get_map_v1", [], true)
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(50);
    // The MQTT receiver decoded the robot's protocol-102 ["ok"] for this
    // request (roborock_mqtt_connector.js counts every decoded frame here).
    api.noteCloudMessageReceived(DUID);
    await jest.advanceTimersByTimeAsync(11_000);
    const outcome = await request;
    expect(String(outcome?.message)).toMatch(/timed out/);
  }
  await jest.advanceTimersByTimeAsync(0);

  expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
  expect(
    log.info.mock.calls.some(([line]) =>
      /starting a fresh MQTT session/.test(line)
    )
  ).toBe(false);
});
