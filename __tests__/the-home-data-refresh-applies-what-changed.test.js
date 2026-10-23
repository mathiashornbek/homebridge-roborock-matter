"use strict";

// The periodic home-data refresh (every 3 minutes) fetched the account's
// current state, stored it, and applied almost none of it: room names were
// filled only at startup, the robot list and products never changed, and the
// platform was never told. A room renamed in the Roborock app kept its old
// name (or "Room <id>") until a restart although the refresh had fetched the
// new one; a robot added to the account was not published until a restart;
// a removed robot kept being polled, its timeouts logged under a raw duid.
// The refresh also read a different endpoint (v1) from startup (v2).
//
// Now startup and refresh both go through one applyHomeData on one endpoint:
// - room names (and the room labels already cached for each robot's maps)
//   follow the app, and the Matter Service Area is told through the HomeData
//   notification it already listens to;
// - a renamed robot is renamed in Apple Home by the platform's discovery;
// - a robot added or removed restarts the start sequence on the same
//   session, so every robot on the account has a runtime and nothing polls a
//   robot that is gone. Apple Home keeps a removed robot's tile until the next
//   restart: unregistering a Matter robot means re-pairing it, and one
//   reading missing a robot is not worth that risk (the stale sweep runs once
//   per process, as it did when discovery could only run once).

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
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  lines,
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
  cloud.requests.length = 0;
  cloud.config.homeData = homeData({
    devices: [STUE],
    rooms: [{ id: 11, name: "Kitchen" }],
  });
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

async function startedAdapter() {
  const api = createAdapterOnFakeCloud(cloud, {
    userData: cloud.issueSession(),
  });
  adapters.push(api);
  api.setReadyListener(jest.fn());
  await api.startService();
  await waitFor(() => api.isInited(), "the start");
  return api;
}

async function refresh() {
  await jest.advanceTimersByTimeAsync(REFRESH_MS);
  await cloud.quiet();
}

test("startup and the refresh read the same endpoint", async () => {
  await startedAdapter();
  await refresh();

  const homes = cloud.requests.filter((r) => /user\/homes\//.test(r.path));
  expect(homes.map((r) => r.path)).toEqual([
    `/v2/user/homes/${cloud.config.homeId}`,
    `/v2/user/homes/${cloud.config.homeId}`,
  ]);
});

test("a room renamed in the app is renamed on the robot's map, and Matter is told", async () => {
  const api = await startedAdapter();
  api.updateRoomMappingCache(STUE.duid, 0, [[1, 11]]);
  const seenWithHomeData = [];
  api.setDeviceNotify((id) => {
    if (id === "HomeData") {
      seenWithHomeData.push(
        api.getRoomMappingsForDevice(STUE.duid).map((room) => room.name)
      );
    }
  });

  cloud.config.homeData = homeData({
    devices: [STUE],
    rooms: [
      { id: 11, name: "Køkken" },
      { id: 12, name: "New room" },
    ],
  });
  await refresh();

  expect(
    api.getRoomMappingsForDevice(STUE.duid).map((room) => room.name)
  ).toEqual(["Køkken"]);
  // The notification the Service Area republishes on already carries it.
  expect(seenWithHomeData).toEqual([["Køkken"]]);
  // And a room the robot reports later is named, not numbered.
  api.updateRoomMappingCache(STUE.duid, 0, [
    [1, 11],
    [2, 12],
  ]);
  expect(
    api.getRoomMappingsForDevice(STUE.duid).map((room) => room.name)
  ).toEqual(["Køkken", "New room"]);
});

test("a robot renamed in the app is published again, without reconnecting", async () => {
  const api = await startedAdapter();

  cloud.config.homeData = homeData({
    devices: [{ ...STUE, name: "Ground floor" }],
  });
  await refresh();

  expect(api.readyListener).toHaveBeenCalledTimes(2);
  expect(api.describeDevice(STUE.duid)).toBe("Ground floor");
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
});

test("an unchanged account changes nothing", async () => {
  const api = await startedAdapter();
  await refresh();
  await refresh();

  expect(api.readyListener).toHaveBeenCalledTimes(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
});

test("a robot added to the account gets a runtime and is published", async () => {
  const api = await startedAdapter();

  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  await jest.advanceTimersByTimeAsync(REFRESH_MS);
  await advanceUntil(
    cloud,
    () => api.readyListener.mock.calls.length === 2,
    "the restart"
  );

  expect(api.vacuums[GARAGE.duid]).toBeDefined();
  expect(api.initializedVacuumDuids.has(GARAGE.duid)).toBe(true);
  expect(lines(api.log.info).join("\n")).toMatch(/added: Garage/);
});

test("a robot removed from the account is no longer polled", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  const api = await startedAdapter();
  expect(api.vacuums[GARAGE.duid]).toBeDefined();

  cloud.config.homeData = homeData({ devices: [STUE] });
  await jest.advanceTimersByTimeAsync(REFRESH_MS);
  await advanceUntil(
    cloud,
    () => api.readyListener.mock.calls.length === 2,
    "the restart"
  );

  expect(api.vacuums[GARAGE.duid]).toBeUndefined();
  expect(api.initializedVacuumDuids.has(GARAGE.duid)).toBe(false);
  expect(lines(api.log.info).join("\n")).toMatch(/removed: Garage/);
});

describe("in Apple Home", () => {
  function makePlatform() {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-"));
    const homebridge = createFakeHomebridge({ storagePath });
    const platform = new RoborockPlatform(
      homebridge.homebridgeLog,
      {
        platform: "RoborockVacuumPlatform",
        email: cloud.config.email,
        baseURL: cloud.host,
        encryptedToken: encryptSession(cloud.issueSession(), storagePath),
        cloudOnlyMode: true,
      },
      homebridge.api
    );
    adapters.push(platform.roborockAPI);
    quiet(platform.roborockAPI);
    return { platform, homebridge };
  }

  test("an added robot is registered, a removed one is not unregistered", async () => {
    cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
    const { homebridge } = makePlatform();
    homebridge.emit("didFinishLaunching");
    await waitFor(
      () => homebridge.matter.registered.length === 2,
      "both registrations"
    );

    const third = robot("duid-sal", "1. Sal");
    cloud.config.homeData = homeData({ devices: [STUE, third] });
    await jest.advanceTimersByTimeAsync(REFRESH_MS);
    await advanceUntil(
      cloud,
      () => homebridge.matter.registered.length === 3,
      "the added robot's registration"
    );

    expect(homebridge.matter.registered.map((a) => a.context.duid)).toEqual([
      STUE.duid,
      GARAGE.duid,
      third.duid,
    ]);
    // Re-pairing is the price of a mistaken unregister; not on one reading.
    expect(
      homebridge.matter.unregisterPlatformAccessories
    ).not.toHaveBeenCalled();
    homebridge.emit("shutdown");
  });
});
