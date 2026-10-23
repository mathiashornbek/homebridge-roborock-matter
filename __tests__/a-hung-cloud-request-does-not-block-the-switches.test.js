"use strict";

// The REST clients had no timeout, so axios waited forever on a request the
// server never answered (a half-open TCP connection, a stuck proxy). Every
// Routine press and schedule read goes through one account-wide queue, so one
// hung request wedged every Routine and schedule switch on the account until
// Homebridge restarted (the root cause noted in the review of PR #39), and a
// hung getHomeDetail at startup never reached the retry loop.
//
// Both clients now give up after a fixed time (30 s; python-roborock relies on
// aiohttp's 300 s default). The tests shorten it through the same option the
// error-log throttle uses, so they run in a fraction of a second against a
// fake server that never answers.

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
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;
const { Roborock } = require("../roborockLib/roborockAPI");
const roborockAuth = require("../roborockLib/lib/roborockAuth");

const DUID = "duid-1";
let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    homeData: homeData({ devices: [robot(DUID, "Stueetage")] }),
  });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  cloud.requests.length = 0;
  mqtt.connect.mockImplementation(() => fakeMqttClient());
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
});

function makeAdapter(options = {}) {
  const api = createAdapterOnFakeCloud(cloud, {
    userData: cloud.issueSession(),
    cloudRestTimeoutMs: 300,
    ...options,
  });
  adapters.push(api);
  return api;
}

test("both clients have a timeout by default", () => {
  const api = new Roborock({ log: console, storagePath: undefined });
  expect(api.cloudRestTimeoutMs).toBe(30_000);
  const loginApi = roborockAuth.createLoginApi({
    baseURL: "euiot.roborock.com",
    username: "someone@example.com",
    clientID: "client",
  });
  expect(loginApi.defaults.timeout).toBe(30_000);
});

test("a Routine run the server never answers gives up, and the next Routine still runs", async () => {
  const api = makeAdapter();
  await api.startService();
  await waitFor(() => api.isInited(), "the start");

  const platform = {
    Service: {},
    Characteristic: {},
    roborockAPI: api,
    api: { updatePlatformAccessories: jest.fn() },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
  const coordinator = new RoborockHapScheduleAccessory(
    platform,
    { context: {}, services: [] },
    DUID
  );

  cloud.script("/user/scene/1/execute", { hang: true });
  const first = coordinator.runRoutine("1", "Morning");
  const second = coordinator.runRoutine("2", "Kitchen now");

  await first;
  await second;

  expect(platform.log.warn.mock.calls.join("\n")).toMatch(
    /Unable to run Roborock routine "Morning": timeout/
  );
  expect(cloud.requestsTo("/user/scene/2/execute")).toHaveLength(1);
});

test("a home-details request the server never answers fails into the retry loop", async () => {
  const api = makeAdapter();
  cloud.script("/api/v1/getHomeDetail", { hang: true });

  await api.startService();

  expect(api.isInited()).toBe(false);
  expect(api.startServiceRetryTimer).toBeTruthy();
});
