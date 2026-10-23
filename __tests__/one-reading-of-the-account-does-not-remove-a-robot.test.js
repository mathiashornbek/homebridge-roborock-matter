"use strict";

/**
 * Since 3.40.0-beta.1 a home-data refresh that lacks a robot removes it:
 * runtime, polling, and its Apple Home switches and sensors (the platform's
 * HAP sweep runs on every ready signal). One reading decided it, and the
 * restart that follows a removal reads again within a second, so one bad
 * answer lasting a few seconds was enough. The accessories came back with
 * the next good refresh as new ones, without their rooms, names and
 * automations. A well-formed empty list removed every robot at once.
 *
 * Now a robot is removed only when two refreshes in a row, an interval
 * apart, lack it; a start's own reading never confirms a removal; and a
 * reading that lists no robot removes nothing.
 */

jest.mock("mqtt");

const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");
const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  advanceUntil,
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

const REFRESH_MS = 180_000;
const STUE = robot("duid-stue", "Stueetage");
const GARAGE = robot("duid-garage", "Garage");
const NEW = robot("duid-new", "Kitchen robot");

let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud();
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
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

async function startPlatform() {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "one-reading-"));
  const homebridge = createFakeHomebridge({ storagePath });
  const platform = new RoborockPlatform(
    homebridge.homebridgeLog,
    {
      platform: "RoborockVacuumPlatform",
      email: cloud.config.email,
      baseURL: cloud.host,
      encryptedToken: encryptSession(cloud.issueSession(), storagePath),
      cloudOnlyMode: true,
      enableHomeKitStateSensors: true,
      homeKitStateSensors: ["docked"],
    },
    homebridge.api
  );
  const api = platform.roborockAPI;
  adapters.push(api);
  quiet(api);
  homebridge.emit("didFinishLaunching");
  await waitFor(() => homebridge.matter.registered.length === 2, "Matter");
  await waitFor(
    () => homebridge.api.registerPlatformAccessories.mock.calls.length >= 2,
    "the state sensors"
  );
  const ready = jest.spyOn(api, "notifyReady");
  return { api, homebridge, ready };
}

/** One refresh, and whatever it starts. */
async function refresh() {
  await jest.advanceTimersByTimeAsync(REFRESH_MS);
  await cloud.quiet();
  await jest.advanceTimersByTimeAsync(10);
  await cloud.quiet();
}

const unregisteredSensors = (homebridge) =>
  homebridge.api.unregisterPlatformAccessories.mock.calls
    .flatMap((call) => call[2])
    .map((accessory) => accessory.context && accessory.context.duid);

const managed = (api) =>
  api
    .getVacuumList()
    .map((device) => device.duid)
    .sort();

test("a robot missing from one refresh keeps its runtime and its Apple Home sensor", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  const { api, homebridge, ready } = await startPlatform();

  cloud.config.homeData = homeData({ devices: [STUE] });
  await refresh();
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  await refresh();

  expect(managed(api)).toEqual([GARAGE.duid, STUE.duid]);
  expect(Object.keys(api.vacuums).sort()).toEqual([GARAGE.duid, STUE.duid]);
  expect(unregisteredSensors(homebridge)).not.toContain(GARAGE.duid);
  expect(ready).not.toHaveBeenCalled();
});

test("a robot missing from two refreshes in a row is removed", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  const { api, homebridge, ready } = await startPlatform();

  cloud.config.homeData = homeData({ devices: [STUE] });
  await refresh();
  expect(managed(api)).toEqual([GARAGE.duid, STUE.duid]);
  await refresh();
  await advanceUntil(cloud, () => ready.mock.calls.length >= 1, "the restart");
  await cloud.quiet();

  expect(managed(api)).toEqual([STUE.duid]);
  expect(Object.keys(api.vacuums)).toEqual([STUE.duid]);
  expect(unregisteredSensors(homebridge)).toContain(GARAGE.duid);
  // A Matter robot is still never unregistered at runtime.
  expect(
    homebridge.matter.unregisterPlatformAccessories
  ).not.toHaveBeenCalled();
});

test("the restart's own reading does not confirm a removal", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  const { api, homebridge, ready } = await startPlatform();

  // A robot is added, so the refresh restarts; Garage is missing from both
  // the refresh and the restart's reading a moment later.
  cloud.config.homeData = homeData({ devices: [STUE, NEW] });
  await refresh();
  await advanceUntil(cloud, () => ready.mock.calls.length >= 1, "the restart");
  await cloud.quiet();
  expect(managed(api)).toEqual([NEW.duid, GARAGE.duid, STUE.duid].sort());

  cloud.config.homeData = homeData({ devices: [STUE, GARAGE, NEW] });
  await refresh();

  expect(managed(api)).toEqual([NEW.duid, GARAGE.duid, STUE.duid].sort());
  expect(unregisteredSensors(homebridge)).not.toContain(GARAGE.duid);
});

test("a reading that lists no robot removes nothing, however often it comes", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  const { api, homebridge, ready } = await startPlatform();

  cloud.config.homeData = homeData({ devices: [] });
  for (let i = 0; i < 3; i += 1) {
    await refresh();
  }

  expect(managed(api)).toEqual([GARAGE.duid, STUE.duid]);
  expect(api.isInited()).toBe(true);
  expect(ready).not.toHaveBeenCalled();
  expect(homebridge.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});
