"use strict";

// A robot shared with the account (home data `receivedDevices` — a partner
// owns the Roborock account and shares the robot) was published to Apple Home
// but never given a runtime. `getVacuumList()`, which the platform publishes
// from, lists owned and shared robots; the runtime list was built from
// `devices` alone. So the tile appeared, every command answered "is not ready
// yet; … missing from your Roborock account", and the tile showed the
// pairing-day snapshot for good.
//
// python-roborock's HomeData.get_all_devices() is devices + received_devices,
// and Home Assistant runs shared robots. Their room names belong to the
// owner's home, so they come from `user/deviceshare/query/{duid}/rooms`
// (python's get_shared_device_rooms, which reads `roomId` as the id).

jest.mock("mqtt");

const mqtt = require("mqtt");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  lines,
  robot,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");

const OWNED = "duid-owned";
const SHARED = "duid-shared";

let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    homeData: homeData({
      devices: [robot(OWNED, "Stueetage")],
      receivedDevices: [robot(SHARED, "Partner's S8")],
      rooms: [{ id: 11, name: "Kitchen" }],
    }),
    sharedRooms: {
      [SHARED]: [
        { roomId: 21, name: "Office" },
        { roomId: 22, name: "Hall" },
      ],
    },
  });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  mqtt.connect.mockImplementation(() => fakeMqttClient());
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
});

async function startedAdapter() {
  const api = createAdapterOnFakeCloud(cloud, {
    userData: cloud.issueSession(),
  });
  adapters.push(api);
  await api.startService();
  await waitFor(() => api.isInited(), "the start");
  return api;
}

test("a shared robot gets a runtime like an owned one", async () => {
  const api = await startedAdapter();

  expect(api.getVacuumList().map((device) => device.duid)).toEqual([
    OWNED,
    SHARED,
  ]);
  expect(api.vacuums[SHARED]).toBeDefined();
  expect(api.initializedVacuumDuids.has(SHARED)).toBe(true);
  // MQTT routes frames by this list.
  expect(api.devices.map((device) => device.duid)).toContain(SHARED);

  const command = jest
    .spyOn(api.vacuums[SHARED], "command")
    .mockResolvedValue("ok");
  await api.startCommand(SHARED, "app_start", []);

  expect(command).toHaveBeenCalledWith(
    SHARED,
    "app_start",
    [],
    expect.anything()
  );
  expect(lines(api.log.warn).join("\n")).not.toMatch(/not ready yet/);
});

test("a shared robot's rooms carry the owner's names", async () => {
  const api = await startedAdapter();

  api.updateRoomMappingCache(SHARED, 0, [
    [1, 21],
    [2, 22],
  ]);

  expect(api.getRoomMappingsForDevice(SHARED).map((room) => room.name)).toEqual(
    ["Office", "Hall"]
  );
  // Owned rooms keep coming from the account's own home.
  expect(api.roomIDs[11]).toBe("Kitchen");
});
