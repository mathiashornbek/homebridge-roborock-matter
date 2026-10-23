"use strict";

/**
 * Every request timeout used to clear the robot's local reassembly buffer —
 * a cloud timeout included. A local reply half-received at that moment then
 * lost its first half, its second half was read as a length prefix, and the
 * reply was gone (usually with a desync warning). python-roborock's decoder
 * never discards buffered bytes except by consuming them (protocol.py
 * `create_local_decoder`). A stalled stream is now handled by the socket
 * liveness rule instead: unanswered pings close the socket.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  rig = await createLanRig();
  await rig.connect();
  rig.robot.result = () => undefined; // the test sends the replies itself
  // A robot never puts a frame inside another on one stream; keep its ping
  // answers from landing between the halves this test sends.
  rig.robot.answersPings = false;
});

afterEach(() => {
  rig.api.localConnector.destroyAllClients();
  rig.api.localConnector.clearLocalDevicedTimeout();
  rig.robot.remove();
  jest.useRealTimers();
});

function send(method, params = []) {
  const request = { outcome: undefined };
  request.done = rig.api.messageQueueHandler
    .sendRequest(rig.duid, method, params)
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    .then((outcome) => {
      request.outcome = outcome;
      return outcome;
    });
  return request;
}

async function halfAReplyArrives(request) {
  const bytes = await rig.robot.replyBytes(request.id, [{ state: 8 }]);
  rig.robot.socket.emit("data", bytes.subarray(0, 20));
  return () => rig.robot.socket.emit("data", bytes.subarray(20));
}

test("a cloud request timing out leaves a half-received local reply intact", async () => {
  const cloud = send("get_multi_maps_list"); // cloud-only
  await jest.advanceTimersByTimeAsync(5_000);
  const local = send("get_prop", ["get_status"]);
  await jest.advanceTimersByTimeAsync(0);
  const rest = await halfAReplyArrives(rig.robot.requests.at(-1));

  await jest.advanceTimersByTimeAsync(5_000); // the cloud request times out
  expect(cloud.outcome.error.message).toMatch(/timed out/);
  rest();
  await jest.advanceTimersByTimeAsync(0);

  expect(local.outcome).toEqual({ value: [{ state: 8 }] });
});

test("a local request timing out leaves another request's half-received reply intact", async () => {
  const first = send("get_consumable");
  await jest.advanceTimersByTimeAsync(5_000);
  const second = send("get_prop", ["get_status"]);
  await jest.advanceTimersByTimeAsync(0);
  const rest = await halfAReplyArrives(rig.robot.requests.at(-1));

  await jest.advanceTimersByTimeAsync(5_000); // the first one times out
  expect(rig.cloudRequests().map((request) => request.method)).toEqual([
    "get_consumable",
  ]);
  rest();
  await jest.advanceTimersByTimeAsync(0);

  expect(second.outcome).toEqual({ value: [{ state: 8 }] });
  expect(first.outcome).toBeUndefined(); // its cloud retry is still waiting
});
