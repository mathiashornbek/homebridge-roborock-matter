"use strict";

/**
 * A start waits several times: for the login, the home data, the MQTT
 * session, the 5 s LAN discovery window, each LAN connect. A shutdown, or a
 * newer start, can land in any of those waits, and each step that carried on
 * afterwards brought something back on an adapter that had moved on: polling
 * armed after a stop, a LAN socket opened after it, the shutdown latch
 * cleared by a restart that a refresh or a rejected session had asked for
 * before the stop, and the 6-hour re-login retry starting next to the
 * runtime it replaced, so every robot was polled twice.
 *
 * Every start is now one run (beginRun), and every step re-reads whether its
 * run is still the current one after each wait.
 */

jest.mock("mqtt");
jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");
const { Roborock } = require("../roborockLib/roborockAPI");
const {
  createLanRig,
  PING_REQUEST,
} = require("../test-support/fake-lan-robot");
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
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");

const HOUR = 60 * 60 * 1000;
const STUE = robot("duid-1", "Stueetage");

const connecting = (api) =>
  lines(api.log.info).filter((line) =>
    /Connecting to your Roborock account/.test(line)
  );

describe("on the fake cloud", () => {
  let cloud;

  beforeAll(async () => {
    cloud = await startFakeRoborockCloud({
      homeData: homeData({ devices: [STUE] }),
      password: "correct horse",
      passwordLogin: "supported",
    });
    cloud.trust();
  });

  afterAll(async () => {
    await cloud.close();
  });

  beforeEach(() => {
    mqtt.connect.mockReset();
    mqtt.connect.mockImplementation(() => fakeMqttClient());
  });

  test("a stop while the start waits for the MQTT session arms no polling and publishes nothing", async () => {
    const api = createAdapterOnFakeCloud(cloud, {
      userData: cloud.issueSession(),
    });
    api.setReadyListener(jest.fn());
    let sessionUp;
    api.rr_mqtt_connector.waitUntilConnected = jest.fn(
      () =>
        new Promise((resolve) => {
          sessionUp = resolve;
        })
    );

    const start = api.startService();
    await waitFor(() => typeof sessionUp === "function", "the MQTT wait");
    await api.stopService();
    sessionUp(true);
    await start;

    expect(api.isInited()).toBe(false);
    expect(api.readyListener).not.toHaveBeenCalled();
    // Both arm intervals in the real adapter.
    expect(api.startB01StatusLoop).not.toHaveBeenCalled();
    expect(api.initializeDeviceUpdates).not.toHaveBeenCalled();
  });

  test("a rejected session whose cleanup outlasts a shutdown does not log in again", async () => {
    const api = createAdapterOnFakeCloud(cloud, {
      userData: cloud.issueSession(),
      password: cloud.config.password,
    });
    api.setReadyListener(jest.fn());
    await api.startService();
    await waitFor(() => api.isInited(), "the start");
    const logins = cloud.requestsTo("/api/v4/auth/email/login/pwd").length;

    let cleanedUp;
    const deleteState = api.deleteStateAsync.bind(api);
    api.deleteStateAsync = jest.fn(async (id) => {
      await new Promise((resolve) => {
        cleanedUp = resolve;
      });
      return deleteState(id);
    });
    const rejected = api.handleRejectedSession(
      new Error("Roborock no longer accepts the saved session (code 2010)")
    );
    await waitFor(() => typeof cleanedUp === "function", "the cleanup");
    await api.stopService();
    cleanedUp();
    await rejected;
    await cloud.quiet();

    expect(api.stopped).toBe(true);
    expect(connecting(api)).toHaveLength(1);
    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(
      logins
    );
  });

  test("the start 6 hours after a second rejected session leaves no polling of the runtime it replaces", async () => {
    useFakeTimersAroundRealIo();
    const api = createAdapterOnFakeCloud(cloud, {
      userData: cloud.issueSession(),
      password: cloud.config.password,
    });
    api.setReadyListener(jest.fn());
    try {
      await api.startService();
      await waitFor(() => api.isInited(), "the start");

      // The first rejection logs in again at once.
      cloud.revokeAllSessions();
      await jest.advanceTimersByTimeAsync(180_000);
      await waitFor(
        () => api.readyListener.mock.calls.length === 2,
        "re-login"
      );

      // The running robot's status poll, where initializeDeviceUpdates keeps
      // it (the fake cloud's adapter stubs that method out).
      let ticks = 0;
      api.vacuums[STUE.duid].getStatusIntervalHandle = api.setInterval(() => {
        ticks += 1;
      }, 15_000);

      // A second rejection within 6 hours waits them out, then starts again.
      cloud.revokeAllSessions();
      await jest.advanceTimersByTimeAsync(180_000);
      await waitFor(() => api.log.error.mock.calls.length > 0, "the error");
      expect(api.startServiceRetryTimer).toBeTruthy();
      await jest.advanceTimersByTimeAsync(6 * HOUR - 5 * 60_000);
      await advanceUntil(
        cloud,
        () => api.readyListener.mock.calls.length === 3,
        "the later re-login",
        200
      );

      ticks = 0;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(ticks).toBe(0);
    } finally {
      await api.stopService();
      jest.useRealTimers();
    }
  });
});

describe("a home-data refresh", () => {
  // A robot added to the account makes the refresh restart. A shared robot's
  // room names are read over HTTPS first, and a stop can land in that read.
  test("that finishes after stopService does not start the adapter again", async () => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const api = new Roborock({
      log,
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "refresh-stop-")),
    });
    api.devices = [{ duid: "duid-stue", name: "Stueetage" }];
    let releaseRooms;
    const roomsAnswer = new Promise((resolve) => {
      releaseRooms = resolve;
    });
    api.api = {
      get: jest.fn(async (url) => {
        if (/^v2\/user\/homes\//.test(url)) {
          return {
            data: {
              result: {
                products: [],
                rooms: [],
                devices: [{ duid: "duid-stue", name: "Stueetage" }],
                receivedDevices: [{ duid: "duid-shared", name: "Shared" }],
              },
            },
          };
        }
        return roomsAnswer;
      }),
    };

    const refresh = api.updateHomeData(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(api.api.get).toHaveBeenCalledWith(
      "user/deviceshare/query/duid-shared/rooms"
    );

    await api.stopService();
    releaseRooms({ data: { success: true, result: [] } });
    await refresh;

    expect(api.stopped).toBe(true);
    expect(connecting(api)).toHaveLength(0);
  });
});

describe("on the LAN", () => {
  let rig;

  beforeEach(async () => {
    jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
    rig = await createLanRig();
  });

  afterEach(() => {
    rig.api.localConnector.destroyAllClients();
    rig.api.localConnector.clearLocalDevicedTimeout();
    rig.robot.remove();
    jest.useRealTimers();
  });

  const pings = () =>
    rig.robot.headers.filter((header) => header.protocol === PING_REQUEST);

  test("a shutdown during the LAN discovery window opens no socket afterwards", async () => {
    const discovery = rig.api.localConnector.getLocalDevices();
    const attach = rig.api.attachLocalTransports(discovery, [
      { duid: rig.duid },
    ]);
    await jest.advanceTimersByTimeAsync(1_000);

    await rig.api.stopService();
    await attach;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(rig.robot.sockets).toHaveLength(0);
    expect(pings()).toHaveLength(0);
  });

  test("a LAN connect in flight at shutdown keeps nothing of its socket", async () => {
    const connect = rig.api.localConnector.createClient(rig.duid, rig.host);
    await rig.api.stopService();
    await connect;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(rig.api.localConnector.localClients[rig.duid]).toBeUndefined();
    expect(rig.robot.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(rig.robot.headers).toHaveLength(0);
  });
});
