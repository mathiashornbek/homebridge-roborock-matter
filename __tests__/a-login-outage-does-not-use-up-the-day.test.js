"use strict";

/**
 * The 20-a-day password-login cap exists so Roborock does not block sign-in.
 * It counted attempts that never reached Roborock (a reset connection on the
 * sign request, a proxy's 502 page), so an outage of about three hours used
 * the day's budget and a correct password then waited until a day after the
 * first attempt, although the network was back long before.
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
  robot,
  useFakeTimersAroundRealIo,
} = require("../test-support/roborock-on-fake-cloud");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PASSWORD = "correct horse";
const SIGN = "/api/v3/key/sign";
const LOGIN = "/api/v4/auth/email/login/pwd";

describe.each([
  [
    "the network drops the sign request (nothing reaches the login)",
    SIGN,
    { destroy: true },
  ],
  [
    "a proxy answers the login with a 502 page",
    LOGIN,
    { status: 502, body: "<html><body><h1>502 Bad Gateway</h1></body></html>" },
  ],
])("%s for the first 20 attempts (about 3 hours)", (_what, path, failure) => {
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

  test("a correct password is back within one retry step once the outage ends", async () => {
    mqtt.connect.mockImplementation(() => fakeMqttClient());
    useFakeTimersAroundRealIo();
    const startedAt = Date.now();
    cloud.script(path, ...Array.from({ length: 20 }, () => failure));
    api = createAdapterOnFakeCloud(cloud, { password: PASSWORD });
    let readyAt = null;
    api.setReadyListener(() => {
      readyAt = Date.now();
    });

    await api.startService();
    let outageEndedAt = null;
    for (let fired = 0; fired < 400 && readyAt === null; fired += 1) {
      await jest.advanceTimersToNextTimerAsync();
      await cloud.quiet();
      if (outageEndedAt === null && cloud.requestsTo(path).length >= 20) {
        outageEndedAt = Date.now();
      }
      if (Date.now() - startedAt > 30 * HOUR) {
        break;
      }
    }

    // The 20th failure came about 2 h 45 min in; the next try should follow
    // within the retry back-off (10 minutes), not ~21 hours later.
    expect((outageEndedAt - startedAt) / HOUR).toBeLessThan(3);
    expect(readyAt).not.toBeNull();
    expect((readyAt - outageEndedAt) / MINUTE).toBeLessThanOrEqual(11);
  });
});
