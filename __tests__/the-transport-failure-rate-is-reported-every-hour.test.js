"use strict";

/**
 * The per-failure "Failed to execute …" warning was throttled to once per 6
 * hours per robot and kind, which hid the rate: on the maintainer's a70, 36
 * lines stood for about 1,418 failures in 6.5 days, and the real pattern (one
 * failed status read every 180 s) could only be recovered by arithmetic on
 * request ids. Now the first failure of each kind in an hour is still logged
 * as it happens, and one line per robot per hour says how its requests fared
 * on each transport, when anything failed.
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

afterEach(() => {
  rig.api.localConnector.destroyAllClients();
  rig.api.localConnector.clearLocalDevicedTimeout();
  rig.robot.remove();
  jest.useRealTimers();
});

async function statusRead({ onCloud } = {}) {
  const outcome = rig.api.messageQueueHandler
    .sendRequest(rig.duid, "get_prop", ["get_status"])
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  await jest.advanceTimersByTimeAsync(0);
  if (onCloud) {
    await onCloud();
  }
  return outcome;
}

const summaries = () =>
  rig.log.info.mock.calls
    .map(([line]) => String(line))
    .filter((line) => /requests in the last hour/.test(line));

/** The cloud answers the retry the moment it is published. */
async function cloudAnswers() {
  const cloud = rig.cloudRequests().at(-1);
  rig.answerCloud(cloud.id, [{ state: 8 }]);
}

test("an hour with failures ends in one line with the counts per transport", async () => {
  for (let i = 0; i < 50; i += 1) {
    await statusRead();
    await jest.advanceTimersByTimeAsync(30_000);
  }
  // Two reads the robot leaves unanswered on the LAN; the cloud answers both.
  rig.robot.result = () => undefined;
  for (let i = 0; i < 2; i += 1) {
    await statusRead({
      onCloud: async () => {
        await jest.advanceTimersByTimeAsync(10_000);
        await cloudAnswers();
      },
    });
  }
  // One read whose socket the robot closes under it.
  await statusRead({
    onCloud: async () => {
      rig.robot.closeConnection();
      await jest.advanceTimersByTimeAsync(0);
      await cloudAnswers();
    },
  });
  rig.robot.result = () => [{ state: 8 }];
  expect(summaries()).toHaveLength(0);

  await jest.advanceTimersByTimeAsync(60 * 60_000);
  await statusRead();

  expect(summaries()).toEqual([
    "Stueetage, requests in the last hour: over the LAN 50 answered, 2 timed out, 1 lost when the socket closed (the socket closed 1 time(s)); over the cloud 3 answered, 0 timed out, 0 not sent; 3 retried over the cloud after the LAN failed.",
  ]);
});

test("an hour without failures logs nothing", async () => {
  for (let i = 0; i < 70; i += 1) {
    await statusRead();
    await jest.advanceTimersByTimeAsync(60_000);
  }

  expect(summaries()).toHaveLength(0);
});

test("the first failure of each kind in an hour is still logged as it happens", async () => {
  const error = Object.assign(
    new Error(
      "Cloud request with id 7 with method get_prop timed out after 10 seconds. MQTT connection state: true"
    ),
    {
      unansweredRequest: true,
      transportWasUp: true,
      transientKind: "cloud timeout",
    }
  );
  const failedAt = async () => {
    await rig.api.catchError(
      error,
      "get_status",
      rig.duid,
      "roborock.vacuum.a70"
    );
  };
  const failures = () =>
    rig.log.warn.mock.calls.filter(([line]) =>
      /Failed to execute get_status/.test(String(line))
    );

  await failedAt();
  await jest.advanceTimersByTimeAsync(30 * 60_000);
  await failedAt();
  expect(failures()).toHaveLength(1);

  await jest.advanceTimersByTimeAsync(31 * 60_000);
  await failedAt();
  expect(failures()).toHaveLength(2);
  expect(String(failures()[1][0])).toMatch(/1 similar warning/);
});
