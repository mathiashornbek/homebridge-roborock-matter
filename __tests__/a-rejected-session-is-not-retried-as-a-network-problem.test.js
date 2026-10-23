"use strict";

// Roborock answers getHomeDetail with code 2010 when it no longer accepts a
// session (password changed, account logged out elsewhere, region changed
// without logging in again). python-roborock raises RoborockInvalidCredentials
// for exactly that answer and Home Assistant starts re-authentication; nothing
// retries with the dead session.
//
// This plugin read `data.rrHomeId` without looking at the code, failed with
// "Cannot read properties of null (reading 'rrHomeId')", called it "almost
// always a temporary Roborock cloud or network problem" and retried with the
// same dead session every 10 minutes for good — never trying the configured
// password, because the stored session always won. At runtime the refresh
// logged an error every 3 minutes while MQTT reconnected every second with
// credentials derived from the dead session.
//
// Now: the dead session is dropped and MQTT closed; with a password, one fresh
// login is made (at most once per 6 hours, python's maximum back-off after an
// authorisation failure); without one, one error says what to do and nothing
// retries. Driven against a fake Roborock server that answers a session it no
// longer knows the way local_roborock_server does: HTTP 401, code 2010.

jest.mock("mqtt");

const crypto = require("crypto");
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
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");

const HOUR = 60 * 60 * 1000;

const mqttUserOf = (userData) =>
  crypto
    .createHash("md5")
    .update(`${userData.rriot.u}:${userData.rriot.k}`)
    .digest("hex")
    .substring(2, 10);

let cloud;
const adapters = [];
let clients;

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    homeData: homeData({ devices: [robot("duid-1", "Stueetage")] }),
    password: "correct horse",
    passwordLogin: "supported",
    // What usiot answers for a DE account (python-roborock PR #960): the
    // version the plugin has always sent, so this file is about the session
    // and not about the agreement.
    agreement: { majorVersion: 14, minorVersion: 0 },
  });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  cloud.requests.length = 0;
  clients = [];
  mqtt.connect.mockReset();
  mqtt.connect.mockImplementation(() => {
    const client = fakeMqttClient();
    clients.push(client);
    return client;
  });
  useFakeTimersAroundRealIo();
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
  jest.useRealTimers();
});

function makeAdapter(options) {
  const api = createAdapterOnFakeCloud(cloud, options);
  adapters.push(api);
  api.setReadyListener(jest.fn());
  return api;
}

function deadSession() {
  const session = cloud.issueSession();
  cloud.revokeAllSessions();
  return session;
}

describe("a session Roborock rejects at startup", () => {
  test("is replaced by one password login, and the start completes", async () => {
    const api = makeAdapter({
      userData: deadSession(),
      password: cloud.config.password,
    });

    await api.startService();
    await waitFor(() => api.isInited(), "the start");

    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(1);
    expect(cloud.requestsTo("/api/v1/getHomeDetail")).toHaveLength(2);
    expect(api.readyListener).toHaveBeenCalledTimes(1);

    // The new session is the one kept, on disk and for MQTT.
    const stored = JSON.parse(api.getStateAsync("UserData").val);
    expect(stored.token).toBe(api.userData.token);
    expect(mqtt.connect).toHaveBeenCalledTimes(1);
    expect(mqtt.connect.mock.calls[0][1].username).toBe(mqttUserOf(stored));

    const said = [...lines(api.log.warn), ...lines(api.log.error)].join("\n");
    expect(said).toMatch(/no longer accepts/);
    expect(said).not.toMatch(/temporary/);
  });

  test("without a password says so once and does not retry", async () => {
    const api = makeAdapter({ userData: deadSession() });

    await api.startService();
    await jest.advanceTimersByTimeAsync(HOUR);

    expect(lines(api.log.error)).toEqual([
      expect.stringMatching(/log in again in the plugin settings/),
    ]);
    expect(lines(api.log.warn).join("\n")).not.toMatch(/temporary/);
    expect(api.startServiceRetryTimer ?? null).toBeNull();
    expect(cloud.requestsTo("/api/v1/getHomeDetail")).toHaveLength(1);
    expect(mqtt.connect).not.toHaveBeenCalled();
    expect(api.isInited()).toBe(false);
  });
});

describe("a session Roborock rejects while running", () => {
  async function startRunning(options = {}) {
    const api = makeAdapter({ userData: cloud.issueSession(), ...options });
    await api.startService();
    await waitFor(() => api.isInited(), "the start");
    return api;
  }

  test("without a password closes MQTT and stops asking", async () => {
    const api = await startRunning();
    const [client] = clients;

    cloud.revokeAllSessions();
    await jest.advanceTimersByTimeAsync(180_000);
    await waitFor(() => api.log.error.mock.calls.length > 0, "the error");

    expect(lines(api.log.error)).toEqual([
      expect.stringMatching(/log in again in the plugin settings/),
    ]);
    // No reconnects with credentials derived from a dead session.
    expect(client.end).toHaveBeenCalled();

    const asked = cloud.requests.length;
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(cloud.requests.length).toBe(asked);
    expect(mqtt.connect).toHaveBeenCalledTimes(1);
  });

  test("with a password logs in again, reconnects MQTT with the new session and publishes again", async () => {
    const api = await startRunning({ password: cloud.config.password });
    const firstUser = mqtt.connect.mock.calls[0][1].username;

    cloud.revokeAllSessions();
    await jest.advanceTimersByTimeAsync(180_000);
    await waitFor(
      () => api.readyListener.mock.calls.length === 2,
      "the second ready"
    );

    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(1);
    expect(mqtt.connect).toHaveBeenCalledTimes(2);
    expect(mqtt.connect.mock.calls[1][1].username).not.toBe(firstUser);
    expect(mqtt.connect.mock.calls[1][1].username).toBe(
      mqttUserOf(api.userData)
    );
    expect(clients[0].end).toHaveBeenCalled();
    expect(api.isInited()).toBe(true);
  });

  test("a second rejection within six hours does not log in again until they are up", async () => {
    const api = await startRunning({ password: cloud.config.password });

    cloud.revokeAllSessions();
    await jest.advanceTimersByTimeAsync(180_000);
    await waitFor(() => api.readyListener.mock.calls.length === 2, "re-login");

    cloud.revokeAllSessions();
    await jest.advanceTimersByTimeAsync(180_000);
    await waitFor(() => api.log.error.mock.calls.length > 0, "the error");

    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(1);
    expect(lines(api.log.error).join("\n")).toMatch(/again in 6 hour\(s\)/);
    expect(api.startServiceRetryTimer).toBeTruthy();

    // Nothing until the six hours are up...
    await jest.advanceTimersByTimeAsync(5 * HOUR);
    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(1);
    // ...and then one fresh login.
    await advanceUntil(
      cloud,
      () => api.readyListener.mock.calls.length === 3,
      "the later re-login"
    );
    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(2);
  });
});
