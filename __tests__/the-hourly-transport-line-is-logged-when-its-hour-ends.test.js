"use strict";

/**
 * The hourly transport line was logged by the first request after its hour
 * had ended. A robot with nothing to report for hours (both links down, or
 * Homebridge idle) later got a line saying "in the last hour" about an hour
 * long gone, and the hour before a shutdown was never reported at all, which
 * is the hour a user restarting over a problem most wants to see.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  rig = await createLanRig();
  await rig.connect();
  rig.robot.result = () => [{ state: 8 }];
});

afterEach(async () => {
  await rig.api.stopService();
  rig.robot.remove();
  jest.useRealTimers();
});

const summaries = () =>
  rig.log.info.mock.calls
    .map(([line]) => String(line))
    .filter((line) => /requests in the last/.test(line));

/** One status read the robot leaves unanswered on the LAN; the cloud answers. */
async function failedOnTheLan() {
  rig.robot.result = () => undefined;
  const outcome = rig.api.messageQueueHandler
    .sendRequest(rig.duid, "get_prop", ["get_status"])
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  await jest.advanceTimersByTimeAsync(10_000);
  const cloud = rig.cloudRequests().at(-1);
  rig.answerCloud(cloud.id, [{ state: 8 }]);
  await outcome;
  rig.robot.result = () => [{ state: 8 }];
}

test("a robot that goes quiet after a failure gets its line when the hour ends, not hours later", async () => {
  await failedOnTheLan();
  // Nothing else is asked of the robot; the keep-alive pings are not requests.
  await jest.advanceTimersByTimeAsync(60 * 60_000);

  expect(summaries()).toEqual([
    "Stueetage, requests in the last hour: over the LAN 0 answered, 1 timed out, 0 lost when the socket closed (the socket closed 0 time(s)); over the cloud 1 answered, 0 timed out, 0 not sent; 1 retried over the cloud after the LAN failed.",
  ]);

  // Hours later, one answered request: no line about the old hour.
  await jest.advanceTimersByTimeAsync(5 * 60 * 60_000);
  await rig.api.messageQueueHandler.sendRequest(rig.duid, "get_prop", [
    "get_status",
  ]);
  expect(summaries()).toHaveLength(1);
});

test("at shutdown the hour not yet over is reported for the time it covers", async () => {
  await failedOnTheLan();
  await jest.advanceTimersByTimeAsync(20 * 60_000 - 10_000);

  await rig.api.stopService();

  expect(summaries()).toEqual([
    "Stueetage, requests in the last 20 minute(s): over the LAN 0 answered, 1 timed out, 0 lost when the socket closed (the socket closed 0 time(s)); over the cloud 1 answered, 0 timed out, 0 not sent; 1 retried over the cloud after the LAN failed.",
  ]);
});

test("a shutdown after an hour without failures logs nothing", async () => {
  await rig.api.messageQueueHandler.sendRequest(rig.duid, "get_prop", [
    "get_status",
  ]);
  await jest.advanceTimersByTimeAsync(20 * 60_000);

  await rig.api.stopService();

  expect(summaries()).toHaveLength(0);
});
