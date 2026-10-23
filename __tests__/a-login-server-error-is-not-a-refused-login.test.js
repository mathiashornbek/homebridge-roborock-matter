"use strict";

/**
 * A failed login request handed back whatever body the error carried, and
 * anything handed back was read as Roborock's answer: a proxy's 502 page
 * became "Login failed: <html>…", which the credential check matches, so a
 * Roborock outage deleted the cached session and home data like a wrong
 * password does. Only Roborock's own answer, an envelope with a numeric
 * code, can refuse a login, and only a known credential refusal deletes
 * anything.
 */

jest.mock("mqtt");

const mqtt = require("mqtt");
const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  advanceUntil,
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  lines,
  robot,
  useFakeTimersAroundRealIo,
} = require("../test-support/roborock-on-fake-cloud");

const PASSWORD = "correct horse";
const LOGIN = "/api/v4/auth/email/login/pwd";
const HOME = homeData({ devices: [robot("duid-1", "Stueetage")] });

let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    homeData: HOME,
    password: PASSWORD,
    passwordLogin: "supported",
  });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  cloud.requests.length = 0;
  mqtt.connect.mockReset();
  mqtt.connect.mockImplementation(() => fakeMqttClient());
  useFakeTimersAroundRealIo();
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
  jest.useRealTimers();
});

/** An adapter with a password, no session, and last run's home data cached. */
async function adapterWithCachedHomeData() {
  const api = createAdapterOnFakeCloud(cloud, { password: PASSWORD });
  adapters.push(api);
  api.setReadyListener(jest.fn());
  await api.setStateAsync("HomeData", {
    val: JSON.stringify(HOME),
    ack: true,
  });
  return api;
}

test.each([
  [
    "a proxy's 502 page",
    { status: 502, body: "<html><body><h1>502 Bad Gateway</h1></body></html>" },
  ],
  ["an empty 503", { status: 503, body: "" }],
  [
    "a 503 envelope with a code that is not a refusal",
    { status: 503, body: { code: 503, msg: "service unavailable" } },
  ],
])(
  "%s from the login endpoint keeps the cached home data, and the login is retried",
  async (_what, answer) => {
    const api = await adapterWithCachedHomeData();
    cloud.script(LOGIN, answer);

    await api.startService();

    expect(api.getStoredHomeData()).toEqual(HOME);
    expect(lines(api.log.warn).join("\n")).toMatch(/Retrying in 1 minute/);
    expect(api.startServiceRetryTimer).toBeTruthy();

    await advanceUntil(cloud, () => api.isInited(), "the retried start");
    expect(cloud.requestsTo(LOGIN)).toHaveLength(2);
  }
);

test("a refused password still drops the cached session and home data", async () => {
  const api = await adapterWithCachedHomeData();
  cloud.script(LOGIN, {
    status: 200,
    body: { code: 2012, msg: "username or password error", data: null },
  });

  await api.startService();

  expect(api.getStoredHomeData()).toBeNull();
  expect(lines(api.log.error).join("\n")).toMatch(/email or password/);
  expect(api.startServiceRetryTimer ?? null).toBeNull();
});
