"use strict";

// A start still waiting on Roborock when Homebridge shuts down went on after
// stopService: it cleared the shutdown latch at entry and never looked again,
// so when the home details arrived it built a new MQTT client and new
// intervals on an adapter that had just been stopped — a stray socket and log
// lines from a process on its way out. It now checks after each wait.

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

let cloud;

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    homeData: homeData({ devices: [robot("duid-1", "Stueetage")] }),
  });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

test.each([
  ["the home details", "/api/v1/getHomeDetail"],
  ["the home data", `/v2/user/homes/4242`],
])(
  "a stop while %s are on the way leaves nothing running",
  async (_label, slowPath) => {
    mqtt.connect.mockReset();
    mqtt.connect.mockImplementation(() => fakeMqttClient());
    const api = createAdapterOnFakeCloud(cloud, {
      userData: cloud.issueSession(),
    });
    api.setReadyListener(jest.fn());
    cloud.script(slowPath, { delayMs: 150 });

    const start = api.startService();
    await waitFor(
      () => cloud.requestsTo(slowPath).length > 0,
      "the slow request"
    );
    await api.stopService();
    await start;

    expect(mqtt.connect).not.toHaveBeenCalled();
    expect(api.homedataInterval ?? null).toBeNull();
    expect(api.isInited()).toBe(false);
    expect(api.readyListener).not.toHaveBeenCalled();
    cloud.requests.length = 0;
  }
);
