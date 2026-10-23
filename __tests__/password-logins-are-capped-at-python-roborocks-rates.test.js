"use strict";

/**
 * The start retry has no attempt cap (an unattended bridge must recover once
 * the network is back), and with a password configured and no session each
 * retry is a password login. A login endpoint that fails for a day cost one
 * login every 10 minutes, about 150, while every attempt counts against
 * Roborock's sign-in limits (9004 blocks sign-in for 7 days). python-roborock
 * caps logins on the client at 1 a second, 3 a minute, 10 an hour and 20 a
 * day; so does the plugin now, and the retry waits for the next free slot.
 */

jest.mock("mqtt");

const mqtt = require("mqtt");
const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  lines,
  robot,
  useFakeTimersAroundRealIo,
} = require("../test-support/roborock-on-fake-cloud");
const { loginWaitMs } = require("../roborockLib/lib/roborockAuth");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PASSWORD = "correct horse";
const LOGIN = "/api/v4/auth/email/login/pwd";

describe("the limits", () => {
  test.each([
    ["none sent", [], 0],
    ["one a second ago", [-SECOND], 0],
    ["one just now", [-1], SECOND - 1],
    [
      "three in the last minute",
      [-50 * SECOND, -20 * SECOND, -5 * SECOND],
      10 * SECOND,
    ],
    [
      "ten in the last hour",
      Array.from({ length: 10 }, (_, i) => -55 * MINUTE + i * 5 * MINUTE),
      5 * MINUTE,
    ],
    [
      "twenty in the last day",
      Array.from({ length: 20 }, (_, i) => -23 * HOUR + i * HOUR),
      HOUR,
    ],
  ])("%s", (_what, ago, expected) => {
    const now = 1_800_000_000_000;
    expect(
      loginWaitMs(
        ago.map((offset) => now + offset),
        now
      )
    ).toBe(expected);
  });
});

describe("a login Roborock refuses all day", () => {
  let cloud;
  let api;

  beforeAll(async () => {
    cloud = await startFakeRoborockCloud({
      homeData: homeData({ devices: [robot("duid-1", "Stueetage")] }),
      password: PASSWORD,
      passwordLogin: "supported",
    });
    cloud.trust();
  });

  afterAll(async () => {
    await api?.stopService();
    await cloud.close();
    jest.useRealTimers();
  });

  test("gets at most 20 password logins a day, and is still retried after them", async () => {
    mqtt.connect.mockImplementation(() => fakeMqttClient());
    useFakeTimersAroundRealIo();
    const startedAt = Date.now();
    // Roborock's own answer, which counts against its sign-in limits (a
    // proxy's error page does not: a-login-outage-does-not-use-up-the-day).
    cloud.script(
      LOGIN,
      ...Array.from({ length: 200 }, () => ({
        status: 500,
        body: { code: 500, msg: "system busy", data: null },
      }))
    );
    api = createAdapterOnFakeCloud(cloud, { password: PASSWORD });
    api.setReadyListener(jest.fn());

    await api.startService();
    let sentInTheFirstDay = 0;
    for (;;) {
      sentInTheFirstDay = cloud.requestsTo(LOGIN).length;
      await jest.advanceTimersToNextTimerAsync();
      await cloud.quiet();
      if (Date.now() - startedAt >= DAY) {
        break;
      }
    }

    expect(sentInTheFirstDay).toBe(20);
    expect(lines(api.log.warn).join("\n")).toMatch(
      /as often as is safe for now .* so it tries again in 22 hour\(s\)\./
    );
    // Waited for, not given up: the next one goes a day after the first.
    expect(cloud.requestsTo(LOGIN)).toHaveLength(21);
    expect(api.startServiceRetryTimer).toBeTruthy();
  });
});
