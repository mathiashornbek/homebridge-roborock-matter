"use strict";

// A start that fails and then succeeds on its own retry must publish the
// robots. Until now discovery was reachable only from the callback the FIRST
// start was given, and that callback ran on the failure path: a Pi that booted
// before DNS was up, or a Roborock maintenance window at start, ended with
// "Roborock connection ready; 3 robot(s) available." a minute later and not one
// robot in Apple Home until somebody restarted the bridge. Homebridge 2.4
// publishes a robot vacuum as an external Matter accessory, which it does not
// restore from its cache, so a robot exists only if this process registers it.
//
// The library now says "ready" every time a start succeeds, and the platform
// runs its (idempotent) discovery on every "ready". There is one retry loop
// for both the login and the home-details stage.
//
// Driven end to end: the real Roborock library logs in against a fake
// Roborock server over real HTTPS, and the real platform is constructed
// against Homebridge's own hap-nodejs and PlatformAccessory.

jest.mock("mqtt");

const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  quiet,
  robot,
  useFakeTimersAroundRealIo,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");
const { createFakeHomebridge } = require("../test-support/fake-homebridge");
const { encryptSession } = require("../src/crypto");
const RoborockPlatform = require("../src/platform").default;

const DUID = "duid-stueetage";
const HOME_DATA = homeData({
  devices: [robot(DUID, "Stueetage")],
  rooms: [{ id: 11, name: "Kitchen" }],
});

let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({ homeData: HOME_DATA });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  mqtt.connect.mockImplementation(() => fakeMqttClient());
  useFakeTimersAroundRealIo();
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
  jest.useRealTimers();
});

function makeAdapter(extra = {}) {
  const api = createAdapterOnFakeCloud(cloud, extra);
  adapters.push(api);
  return api;
}

describe("the library says ready after every successful start", () => {
  test("a start that fails at the home details and succeeds on its retry signals ready once", async () => {
    const api = makeAdapter({ userData: cloud.issueSession() });
    const ready = jest.fn(() => api.isInited());
    api.setReadyListener(ready);

    // getaddrinfo EAI_AGAIN, as far as the client can tell: the connection
    // dies without an answer.
    cloud.script("/api/v1/getHomeDetail", { destroy: true });
    await api.startService();

    expect(api.isInited()).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    expect(api.startServiceRetryTimer).toBeTruthy();

    await jest.advanceTimersByTimeAsync(60_000);
    await waitFor(() => ready.mock.calls.length > 0, "ready");

    expect(api.isInited()).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    // Called once the robots are there, so discovery has something to publish.
    expect(ready.mock.results[0].value).toBe(true);
    expect(api.getVacuumList().map((device) => device.duid)).toEqual([DUID]);
  });

  test("a login that fails on the network is retried by the same loop and then signals ready", async () => {
    const userData = cloud.issueSession();
    const api = makeAdapter({ password: "irrelevant" });
    api.setReadyListener(jest.fn());
    // No stored session: the start has to log in, and the first login dies.
    cloud.script("/api/v3/key/sign", { destroy: true });
    api.getUserData = jest
      .fn()
      .mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN localhost"))
      .mockResolvedValue(userData);

    await api.startService();

    expect(api.startServiceRetryTimer).toBeTruthy();
    expect(api.loginRetryTimer ?? null).toBeNull();

    await jest.advanceTimersByTimeAsync(60_000);
    await waitFor(() => api.isInited(), "the retried start");
    expect(api.readyListener).toHaveBeenCalledTimes(1);
  });
});

describe("the platform publishes the robots on every ready", () => {
  function makePlatform() {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "platform-"));
    const homebridge = createFakeHomebridge({ storagePath });
    const session = cloud.issueSession();
    const config = {
      platform: "RoborockVacuumPlatform",
      email: cloud.config.email,
      baseURL: cloud.host,
      encryptedToken: encryptSession(session, storagePath),
      cloudOnlyMode: true,
      enableHomeKitActionSwitches: true,
      homeKitActionSwitches: ["dock"],
    };

    // A "Return to Dock" switch Homebridge restored from its cache, paired
    // and placed in a room long ago. It must get its handler back.
    const { hap, PlatformAccessory } = homebridge;
    const cachedSwitch = new PlatformAccessory(
      "Stueetage Return to Dock",
      hap.uuid.generate(`hap:roborock:action:${DUID}:dock`)
    );
    cachedSwitch.context = { duid: DUID, kind: "actionSwitch", action: "dock" };
    cachedSwitch.addService(hap.Service.Switch, "Stueetage Return to Dock");

    const platform = new RoborockPlatform(
      homebridge.homebridgeLog,
      config,
      homebridge.api
    );
    adapters.push(platform.roborockAPI);
    quiet(platform.roborockAPI);
    platform.configureAccessory(cachedSwitch);

    return { platform, homebridge, cachedSwitch };
  }

  test("a robot is registered in Apple Home once a retried start succeeds", async () => {
    const { homebridge, cachedSwitch } = makePlatform();

    cloud.script("/api/v1/getHomeDetail", { destroy: true });
    homebridge.emit("didFinishLaunching");
    await waitFor(
      () => homebridge.homebridgeLog.warn.mock.calls.length > 0,
      "the failure to be reported"
    );
    expect(
      homebridge.matter.registerPlatformAccessories
    ).not.toHaveBeenCalled();
    // Says what will happen next, and that it will happen by itself.
    expect(homebridge.homebridgeLog.warn.mock.calls.flat().join("\n")).toMatch(
      /Retrying in 1 minute\(s\)/
    );

    await jest.advanceTimersByTimeAsync(60_000);
    await waitFor(
      () => homebridge.matter.registered.length > 0,
      "the Matter registration"
    );

    expect(homebridge.matter.registered.map((a) => a.context.duid)).toEqual([
      DUID,
    ]);
    const on = cachedSwitch
      .getService(homebridge.hap.Service.Switch)
      .getCharacteristic(homebridge.hap.Characteristic.On);
    // hap-nodejs keeps the handler it was given; a cached switch with no
    // handler takes the press and does nothing.
    expect(typeof on.setHandler).toBe("function");

    homebridge.emit("shutdown");
  });

  test("a second ready registers nothing twice", async () => {
    const { platform, homebridge } = makePlatform();

    homebridge.emit("didFinishLaunching");
    await waitFor(
      () => homebridge.matter.registered.length > 0,
      "the first registration"
    );

    // Two more readies back to back, as a re-login and a home-data change
    // could produce: discovery runs one at a time and only updates.
    platform.roborockAPI.notifyReady();
    platform.roborockAPI.notifyReady();
    await waitFor(
      () => homebridge.matter.updatePlatformAccessories.mock.calls.length >= 2,
      "two discovery runs"
    );

    expect(homebridge.matter.registerPlatformAccessories).toHaveBeenCalledTimes(
      1
    );
    homebridge.emit("shutdown");
  });
});
