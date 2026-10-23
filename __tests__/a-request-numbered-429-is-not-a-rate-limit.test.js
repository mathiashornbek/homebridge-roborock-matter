"use strict";

// Any standalone "429" anywhere in an error's text was read as HTTP 429 Too
// Many Requests, and that pauses every schedule and Routine switch on the
// account for 65 minutes. Two of the plugin's own timeout messages carry such
// a number by construction: the request id (the counter wraps at 10,000, so
// every robot's 429th, 10,429th, ... request has it) and the count of cloud
// messages received since startup. Both errors below are produced by the real
// request queue, not written by hand.
//
// A rate limit is now recognised only from a status field (HTTP 429 on the
// error or its response) or from a phrase that says so, never from a number
// in free text.

jest.mock("mqtt");

const axios = require("axios");
const mqtt = require("mqtt");

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");
const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  createAdapterOnFakeCloud,
  fakeMqttClient,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");
const {
  isDefiniteScheduleThrottle,
} = require("../src/hap_schedule_accessory.ts");

const DUID = "duid-a70";

async function cloudTimeout({ requestId = 17, receivedBefore = 0 } = {}) {
  jest.useFakeTimers();
  try {
    const { api } = createRealRoborockOnFakeWire({ transport: "cloud" });
    api.rr_mqtt_connector.reconnectClient = jest.fn(async () => true);
    for (let i = 0; i < receivedBefore; i += 1) {
      api.noteCloudMessageReceived(DUID);
    }
    api.idCounter = requestId;
    const outcome = api.messageQueueHandler
      .sendRequest(DUID, "get_server_timer", [])
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(11_000);
    return await outcome;
  } finally {
    jest.useRealTimers();
  }
}

describe("a timeout is not a rate limit because of a number in its text", () => {
  test("request id 429", async () => {
    const error = await cloudTimeout({ requestId: 429 });
    expect(error.message).toMatch(/Cloud request with id 429 .*timed out/);
    expect(isDefiniteScheduleThrottle(error)).toBe(false);
  });

  test("429 cloud messages since startup", async () => {
    const error = await cloudTimeout({ receivedBefore: 429 });
    expect(error.message).toMatch(/\(429 cloud message\(s\) since startup\)/);
    expect(isDefiniteScheduleThrottle(error)).toBe(false);
  });
});

describe("a real rate limit is still recognised", () => {
  let cloud;
  beforeAll(async () => {
    cloud = await startFakeRoborockCloud();
    cloud.trust();
  });
  afterAll(async () => {
    await cloud.close();
  });

  test("an HTTP 429 answer, as axios reports it", async () => {
    cloud.script("/user/scene/device/x", {
      status: 429,
      body: { success: false, msg: "slow down" },
    });
    const error = await axios
      .get(`${cloud.url}/user/scene/device/x`)
      .catch((thrown) => thrown);

    expect(error.response.status).toBe(429);
    expect(isDefiniteScheduleThrottle(error)).toBe(true);
  });

  test("a routine read the cloud refuses with a rate-limit message", async () => {
    mqtt.connect.mockImplementation(() => fakeMqttClient());
    const api = createAdapterOnFakeCloud(cloud, {
      userData: cloud.issueSession(),
    });
    try {
      await api.startService();
      await waitFor(() => api.isInited(), "the start");
      cloud.script(`/user/scene/device/${DUID}`, {
        body: { success: false, msg: "Too Many Requests", result: null },
      });

      const error = await api.getCloudScenes(DUID).catch((thrown) => thrown);

      expect(error.message).toMatch(/Too Many Requests/);
      expect(isDefiniteScheduleThrottle(error)).toBe(true);
    } finally {
      await api.stopService();
    }
  });
});
