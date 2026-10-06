"use strict";

/**
 * A cloud session that says it is connected and delivers nothing (3.36.0).
 *
 * python-roborock restarts its MQTT session after 3 cloud timeouts in a row,
 * at most once every 30 minutes (mqtt/health_manager.py), because "the MQTT
 * connection appears to be alive but no messages are being received". This
 * plugin reconnected only when mqtt.js reported the link DOWN. These drive the
 * real message queue and timers; only the wire is faked.
 */

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const DUID = "duid-s8";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function timeOut(api, method = "get_prop") {
  const request = api.messageQueueHandler
    .sendRequest(DUID, method, [])
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(11_000);
  return request;
}

function harness() {
  const wire = createRealRoborockOnFakeWire({ transport: "cloud" });
  wire.api.rr_mqtt_connector.reconnectClient = jest.fn(async () => true);
  return wire;
}

test("3 unanswered cloud requests in a row start a fresh session, once", async () => {
  const { api, log } = harness();

  await timeOut(api);
  await timeOut(api);
  expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
  await timeOut(api);
  await jest.advanceTimersByTimeAsync(0);

  expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(1);
  expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledWith(true);
  expect(
    log.info.mock.calls.some(([line]) =>
      /starting a fresh MQTT session/.test(line)
    )
  ).toBe(true);
});

test("not more than once every 30 minutes", async () => {
  const { api } = harness();

  for (let i = 0; i < 9; i += 1) {
    await timeOut(api);
  }
  await jest.advanceTimersByTimeAsync(0);
  expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
  for (let i = 0; i < 3; i += 1) {
    await timeOut(api);
  }
  await jest.advanceTimersByTimeAsync(0);
  expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(2);
});

test("a reply in between starts the count again", async () => {
  const { api } = harness();

  await timeOut(api);
  await timeOut(api);
  api.noteCloudReply();
  await timeOut(api);
  await timeOut(api);
  await jest.advanceTimersByTimeAsync(0);

  expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
});

test("a link that is down is not a quiet session", async () => {
  const { api } = harness();
  api.rr_mqtt_connector.isConnected = jest.fn(() => false);
  // With MQTT down the request is refused outright; nothing to restart here —
  // the existing reconnect path owns that case.
  for (let i = 0; i < 4; i += 1) {
    await timeOut(api);
  }
  await jest.advanceTimersByTimeAsync(0);
  expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
});
