"use strict";

/**
 * python-roborock's per-command fallback (devices/rpc/v1_channel.py
 * `RpcChannel.send_command`): a V1 command is tried over the LAN first when the
 * socket is up, and when that attempt fails — the robot did not answer within
 * the timeout, or the socket went — the SAME request (same id) is sent once
 * more over MQTT. A refusal is an answer and is not retried.
 *
 * On 3.39.0 a request whose socket closed under it waited out its full 10 s
 * and failed with "Local request … timed out … Local connect state: false",
 * the line the maintainer's a70 logged throughout 16–23 Oct, and the next poll
 * a minute later was the one that went to the cloud.
 *
 * Driven on the real adapter, localConnector and message queue; only the
 * socket is a fake robot (test-support/fake-lan-robot.js).
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");
const {
  isUnansweredRequest,
} = require("../roborockLib/lib/unansweredMethodBreaker");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  rig = await createLanRig();
  await rig.connect();
  // A robot that answers nothing on the LAN unless a test says otherwise.
  rig.robot.result = () => undefined;
});

afterEach(() => {
  rig.api.localConnector.destroyAllClients();
  rig.api.localConnector.clearLocalDevicedTimeout();
  rig.robot.remove();
  jest.useRealTimers();
});

function statusRead(options = {}) {
  return rig.api.messageQueueHandler
    .sendRequest(rig.duid, "get_prop", ["get_status"], false, false, options)
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
}

test("the socket closes under a status read: the same request goes over MQTT at once and resolves from the cloud", async () => {
  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(1_000);
  const [local] = rig.robot.requests;
  expect(local.method).toBe("get_prop");
  expect(rig.api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();

  rig.robot.closeConnection();
  await jest.advanceTimersByTimeAsync(0);

  // Not after the 10 s timeout: the socket is known to be gone now.
  expect(rig.cloudRequests()).toEqual([
    expect.objectContaining({
      id: local.id,
      method: "get_prop",
      params: ["get_status"],
    }),
  ]);
  rig.answerCloud(local.id, [{ state: 8 }]);
  await expect(outcome).resolves.toEqual({ value: [{ state: 8 }] });
});

test("a status read the robot leaves unanswered on a live socket is retried once over MQTT", async () => {
  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(9_000);
  expect(rig.api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(1_000);
  const [cloud] = rig.cloudRequests();
  expect(cloud.id).toBe(rig.robot.requests[0].id);

  rig.answerCloud(cloud.id, [{ state: 8 }]);
  await expect(outcome).resolves.toEqual({ value: [{ state: 8 }] });
  expect(rig.api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
});

test("with the cloud down too, a request lost with its socket fails at once as a transport condition", async () => {
  rig.api.rr_mqtt_connector.isConnected.mockReturnValue(false);
  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(1_000);

  rig.robot.closeConnection();
  await jest.advanceTimersByTimeAsync(0);
  const { error } = await outcome;

  expect(error.message).toMatch(/closed before get_prop/);
  expect(error.transientKind).toBe("local connection unavailable");
  expect(isUnansweredRequest(error)).toBe(false);
  expect(rig.api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
});

test("a refusal on the LAN is an answer and is not retried over the cloud", async () => {
  rig.robot.refusal = () => ({ code: -10007, message: "invalid status" });
  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(1_000);

  const { error } = await outcome;
  expect(error.message).toMatch(/invalid status/);
  expect(rig.api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
});

test("a caller's explicit budget is shared: the cloud retry gets only what is left of it", async () => {
  const outcome = statusRead({ requestTimeoutMs: 2_000 });
  await jest.advanceTimersByTimeAsync(500);
  rig.robot.closeConnection();
  await jest.advanceTimersByTimeAsync(0);
  expect(rig.api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(1_499);
  let settled = false;
  void outcome.then(() => {
    settled = true;
  });
  await jest.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  const { error } = await outcome;
  expect(error.message).toMatch(/Cloud request .* timed out after 2 seconds/);
});

test("a caller's budget spent on the LAN leaves nothing for a retry", async () => {
  const outcome = statusRead({ requestTimeoutMs: 2_000 });
  await jest.advanceTimersByTimeAsync(2_000);

  const { error } = await outcome;
  expect(error.message).toMatch(/Local request .* timed out after 2 seconds/);
  expect(rig.api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
});

test("the cloud retry of a request whose socket closed is not held against the method", async () => {
  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(1_000);
  rig.robot.closeConnection();
  await jest.advanceTimersByTimeAsync(10_000);

  const { error } = await outcome;
  expect(error.message).toMatch(/Cloud request .* timed out/);
  expect(error.message).toMatch(/closed before get_prop/);
  expect(isUnansweredRequest(error)).toBe(false);
});

test("a request whose LAN and cloud attempts both drew silence on links that stayed up is held against the method", async () => {
  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(20_000);

  const { error } = await outcome;
  expect(error.message).toMatch(/Cloud request .* timed out/);
  expect(error.message).toMatch(/Local request .* timed out/);
  expect(isUnansweredRequest(error)).toBe(true);
});
