"use strict";

/**
 * A robot that answers the hello but leaves every request unanswered (frames
 * under a stale local key, say: the hello and the ping are bare headers, the
 * requests are encrypted). Three request timeouts close the socket with a
 * warning; the reconnect's hello was answered, and that alone ended the
 * episode: an "answers on the LAN again" line, the reconnect back-off reset,
 * and the next three timeouts were a new episode with a new warning. About
 * every 45 s, for good (3.39.0 warned once).
 *
 * python-roborock never closes a socket for silence, so it only pays the
 * 10 s LAN wait on every request. This plugin closes it, so it decides what
 * ends an episode: a request the robot answers. A hello still lets requests
 * try the new socket.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  rig = await createLanRig();
  await rig.connect();
});

afterEach(() => {
  rig.api.localConnector.destroyAllClients();
  rig.api.localConnector.clearLocalDevicedTimeout();
  rig.robot.remove();
  jest.useRealTimers();
});

/** Answer every cloud request still waiting, as a working cloud would. */
function cloudAnswersEverything() {
  for (const request of rig.cloudRequests()) {
    if (rig.api.pendingRequests.has(request.id)) {
      rig.answerCloud(request.id, [{ state: 8 }]);
    }
  }
}

/** One status poll, every 15 s as CLASSIC_STATUS_TICK_MS. */
async function poll() {
  const outcome = rig.api.messageQueueHandler
    .sendRequest(rig.duid, "get_prop", ["get_status"])
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  await jest.advanceTimersByTimeAsync(0);
  cloudAnswersEverything();
  await jest.advanceTimersByTimeAsync(10_000);
  cloudAnswersEverything();
  await outcome;
  await jest.advanceTimersByTimeAsync(5_000);
}

const stoppedAnswering = () =>
  rig.log.warn.mock.calls.filter(([line]) =>
    /stopped answering/.test(String(line))
  ).length;
const answersAgain = () =>
  rig.log.info.mock.calls.filter(([line]) =>
    /answers on the LAN again/.test(String(line))
  ).length;

test("ten minutes of a robot that answers only the hello is one warning, and the reconnects back off", async () => {
  rig.robot.answersPings = false;
  rig.robot.answersRequests = false;

  for (let i = 0; i < 40; i += 1) {
    await poll();
  }

  expect({ warns: stoppedAnswering(), backOnLan: answersAgain() }).toEqual({
    warns: 1,
    backOnLan: 0,
  });
  // 15 s, then 60 s growing by 1.5: not a new socket every 45 s.
  expect(rig.robot.sockets.length).toBeLessThanOrEqual(6);
});

test("the episode ends when the robot answers a request again, with one line", async () => {
  rig.robot.answersPings = false;
  rig.robot.answersRequests = false;
  for (let i = 0; i < 4; i += 1) {
    await poll();
  }
  expect(stoppedAnswering()).toBe(1);

  rig.robot.answersRequests = true;
  for (let i = 0; i < 40 && answersAgain() === 0; i += 1) {
    await poll();
  }

  expect(answersAgain()).toBe(1);
  expect(rig.api.localConnector.isConnected(rig.duid)).toBe(true);
  expect(rig.api.localConnector.reconnectAttempts.has(rig.duid)).toBe(false);
});

// The rule the late-reply comment states: a reply that comes after its
// request timed out does not reset the socket's run of unanswered requests.
// handleLocalData reset it on any data, so a socket on which every reply was
// too late was never closed.
test("a socket on which every reply comes too late is closed like a silent one", async () => {
  rig.robot.answersPings = false;
  rig.robot.answersRequests = false;
  const socket = rig.robot.socket;

  for (let i = 0; i < 3; i += 1) {
    const outcome = rig.api.messageQueueHandler
      .sendRequest(rig.duid, "get_prop", ["get_status"])
      .then(
        (value) => ({ value }),
        (error) => ({ error })
      );
    await jest.advanceTimersByTimeAsync(10_000); // LAN timeout -> cloud retry
    const request = rig.robot.requests.at(-1);
    cloudAnswersEverything();
    await outcome;
    // The robot's reply, after the cloud already answered.
    await rig.robot.reply(socket, request.id, [{ state: 8 }]);
    await jest.advanceTimersByTimeAsync(5_000);
  }

  expect(stoppedAnswering()).toBe(1);
  expect(socket.destroyed).toBe(true);
});
