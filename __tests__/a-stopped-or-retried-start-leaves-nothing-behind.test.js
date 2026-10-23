"use strict";

/**
 * Lifecycle edges that left work running after it should have stopped.
 *
 * 1. A start that failed after the MQTT client was created (anything throwing
 *    in device setup) was retried by `scheduleStartServiceRetry`, and the
 *    retry created a second client without ending the first. Both used one
 *    clientId, so the broker kept disconnecting one for the other, the old
 *    one still delivered every frame, and shutdown only ended the new one.
 *    The health-check and home-data intervals of the failed attempt kept
 *    running beside the new ones.
 * 2. A home-data refresh still on the wire when Homebridge stopped landed
 *    after `stopService` and restarted the polling loops.
 * 3. A B01 map request in flight at shutdown kept its 20-second timer, which
 *    then ran the live-room failure handling against a stopped adapter.
 */

jest.mock("mqtt");

const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");
const axios = require("axios");
const roborockAuth = require("../roborockLib/lib/roborockAuth");
const { Roborock } = require("../roborockLib/roborockAPI");

const HOMEDATA = {
  products: [{ id: "p", model: "roborock.vacuum.a70" }],
  devices: [
    {
      duid: "d1",
      name: "Stueetage",
      productId: "p",
      pv: "1.0",
      localKey: "k",
      online: true,
    },
  ],
  receivedDevices: [],
  rooms: [],
};

function log() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function fakeClient() {
  const client = new EventEmitter();
  client.ended = false;
  client.subscribe = jest.fn();
  client.publish = jest.fn();
  client.end = jest.fn(() => {
    client.ended = true;
  });
  client.endAsync = jest.fn(async () => {
    client.ended = true;
  });
  return client;
}

const created = [];
afterEach(async () => {
  for (const api of created.splice(0)) {
    await api.stopService();
    if (api.startServiceRetryTimer) {
      clearTimeout(api.startServiceRetryTimer);
    }
  }
  jest.restoreAllMocks();
});

function makeApi() {
  const api = new Roborock({
    username: "a@b",
    password: "x",
    cloudOnlyMode: true,
    log: log(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-")),
    userData: {
      token: "t",
      rriot: {
        u: "u",
        s: "s",
        k: "kkkkkkkk",
        r: { a: "http://api.invalid", m: "mqtt://broker.invalid" },
      },
    },
  });
  api.startB01StatusLoop = jest.fn();
  created.push(api);
  return api;
}

describe("a retried start", () => {
  test("ends the MQTT client and the timers of the attempt that failed", async () => {
    const clients = [];
    mqtt.connect.mockImplementation(() => {
      const client = fakeClient();
      clients.push(client);
      return client;
    });
    jest.spyOn(roborockAuth, "createLoginApi").mockReturnValue({
      defaults: { headers: { common: {} } },
      // getHomeDetail as Roborock answers it: the envelope carries a code.
      get: async () => ({ data: { code: 200, data: { rrHomeId: 1 } } }),
    });
    jest.spyOn(axios, "create").mockReturnValue({
      interceptors: { request: { use() {} } },
      getUri: () => "http://api.invalid/",
      get: async () => ({ data: { result: HOMEDATA } }),
    });

    const api = makeApi();
    const live = new Set();
    const setInterval = api.setInterval.bind(api);
    const clearInterval = api.clearInterval.bind(api);
    api.setInterval = (...args) => {
      const handle = setInterval(...args);
      live.add(handle);
      return handle;
    };
    api.clearInterval = (handle) => {
      live.delete(handle);
      return clearInterval(handle);
    };
    let attempts = 0;
    api.createDevices = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("device setup failed");
      }
    });
    api.rr_mqtt_connector.waitUntilConnected = async () => false;

    await api.startService();
    expect(clients).toHaveLength(1);
    const intervalsAfterFailure = live.size;
    expect(api.startServiceRetryTimer).toBeTruthy();
    clearTimeout(api.startServiceRetryTimer);
    api.startServiceRetryTimer = null;

    // What the retry timer does.
    await api.startService();

    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    // The old client's frames reach nothing; the new client's do.
    const route = jest.spyOn(api.rr_mqtt_connector, "resolveDuidFromTopic");
    clients[0].emit("message", "rr/m/o/u/x/d1", Buffer.alloc(0));
    expect(route).not.toHaveBeenCalled();
    clients[1].emit("message", "rr/m/o/u/x/d1", Buffer.alloc(0));
    expect(route).toHaveBeenCalledTimes(1);
    expect(live.size).toBe(intervalsAfterFailure);

    await api.stopService();
    expect(clients[1].ended).toBe(true);
  });
});

describe("a home-data refresh that lands after shutdown", () => {
  test("does not start the polling loops again", async () => {
    const api = makeApi();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify(HOMEDATA),
      ack: true,
    });
    let release;
    api.api = {
      get: () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { result: HOMEDATA } });
        }),
    };
    api.superviseDeviceIntervals = jest.fn();
    api.refreshLocalKeysFromHomeData = jest.fn(async () => []);

    const refresh = api.updateHomeData(1);
    await new Promise((resolve) => setImmediate(resolve));
    await api.stopService();
    release();
    await refresh;

    expect(api.superviseDeviceIntervals).not.toHaveBeenCalled();
    expect(api.refreshLocalKeysFromHomeData).not.toHaveBeenCalled();
  });
});

describe("a B01 map request in flight at shutdown", () => {
  test("is settled at stop and not counted as a live-room failure", async () => {
    jest.useFakeTimers();
    try {
      const api = makeApi();
      api.message.buildPayload = async () => "{}";
      api.message.buildRoborockMessage = async () => Buffer.from("frame");
      api.rr_mqtt_connector.sendMessage = jest.fn();
      api.noteLiveRoomFetchFailed = jest.fn();

      const request = api.sendB01MapRequest("d1", 0).catch((error) => error);
      await Promise.resolve();
      await Promise.resolve();
      expect(api.pendingB01MapRequests.size).toBe(1);

      await api.stopService();
      const outcome = await request;

      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome.message)).toMatch(/shutting down/);
      expect(api.pendingB01MapRequests.size).toBe(0);
      // Nothing is left to fire 20 seconds later.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a request that shutdown cut short", () => {
  test("is not reported as a failure at error level", async () => {
    const api = makeApi();
    await api.stopService();

    await api.catchError(
      new Error("Homebridge is shutting down."),
      "get_water_box_custom_mode",
      "d1",
      "roborock.vacuum.a70"
    );

    expect(api.log.error).not.toHaveBeenCalled();
    expect(api.log.warn).not.toHaveBeenCalled();
  });
});
