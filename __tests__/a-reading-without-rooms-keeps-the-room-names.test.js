"use strict";

/**
 * Each home-data reading used to replace the room names wholesale. A refresh
 * whose reading carried no rooms left the cached labels alone, but the
 * robot's next room report (it reports its rooms on every map read) then
 * named every room "Room <id>", and Apple Home's room list showed "Room 11"
 * for "Kitchen" until a reading with rooms came. A reading now adds and
 * renames rooms; it never forgets one.
 */

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
  useFakeTimersAroundRealIo,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");

const REFRESH_MS = 180_000;
const STUE = robot("duid-stue", "Stueetage");

let cloud;
let api;

beforeAll(async () => {
  cloud = await startFakeRoborockCloud();
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(async () => {
  useFakeTimersAroundRealIo();
  mqtt.connect.mockReset();
  mqtt.connect.mockImplementation(() => fakeMqttClient());
  cloud.config.homeData = homeData({
    devices: [STUE],
    rooms: [{ id: 11, name: "Kitchen" }],
  });
  api = createAdapterOnFakeCloud(cloud, { userData: cloud.issueSession() });
  api.setReadyListener(jest.fn());
  await api.startService();
  await waitFor(() => api.isInited(), "the start");
  // The robot reports segment 1 as room 11.
  api.updateRoomMappingCache(STUE.duid, 0, [[1, 11]]);
});

afterEach(async () => {
  await api.stopService();
  jest.useRealTimers();
});

const segmentName = () =>
  api.roomMappings[STUE.duid].rooms.find((room) => room.segmentId === 1).name;

async function refreshWith(rooms) {
  cloud.config.homeData = homeData({ devices: [STUE], rooms });
  await jest.advanceTimersByTimeAsync(REFRESH_MS);
  await cloud.quiet();
}

test("a room the robot reports after a reading without rooms keeps its name", async () => {
  expect(segmentName()).toBe("Kitchen");

  await refreshWith([]);
  api.updateRoomMappingCache(STUE.duid, 0, [[1, 11]]);

  expect(segmentName()).toBe("Kitchen");
});

test("a room renamed in the app is still renamed", async () => {
  await refreshWith([{ id: 11, name: "Køkken" }]);
  api.updateRoomMappingCache(STUE.duid, 0, [[1, 11]]);

  expect(segmentName()).toBe("Køkken");
});
