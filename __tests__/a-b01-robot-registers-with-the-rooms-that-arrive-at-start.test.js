"use strict";

/**
 * Homebridge fixes a Matter accessory's clusters when it registers it. A B01
 * robot's rooms arrive just after start — a Q7's from its room read, a Q10's
 * from the map it pushes when asked — so on a first start (no room list kept
 * yet) the accessory was registered without a Service Area, and could not
 * gain one until Homebridge restarted. Every Q10's first start on 3.40 was
 * in that state. Discovery now gives such a robot a few seconds for its
 * first room list before registering it.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const RoborockPlatform = require("../src/platform").default;
const {
  createB01Robots,
  buildQ10MapPacket,
  Q10_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

const DUID = "duid-q10";
const ROOMS = [
  { id: 9, name: "rr_living_room" },
  { id: 3, name: "Køkken" },
];

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/** The real platform's discovery over the real protocol library. */
function platformOver(api) {
  const platform = Object.create(RoborockPlatform.prototype);
  platform.log = createLog();
  platform.platformConfig = { enableMatter: true };
  platform.accessories = [];
  platform.api = {
    hap: { uuid: { generate: (seed) => `uuid-${seed}` } },
    unregisterPlatformAccessories: jest.fn(),
  };
  platform.matterAccessories = [];
  platform.matterVacuums = new Map();
  platform.stateSensors = new Map();
  platform.shouldAcceptUnscopedLiveMessage = () => true;
  platform.refreshStateSensorsForRobot = () => {};
  const registered = [];
  const matter = {
    deviceTypes: { RoboticVacuumCleaner: "rvc" },
    updateAccessoryState: jest.fn(async () => undefined),
    registerPlatformAccessories: jest.fn(async (_plugin, _platform, list) => {
      // What Homebridge builds the endpoint from, as it was at registration.
      registered.push(
        ...list.map((accessory) => JSON.parse(JSON.stringify(accessory)))
      );
    }),
    updatePlatformAccessories: jest.fn(async () => undefined),
  };
  platform.getMatterApi = () => matter;
  platform.roborockAPI = api;
  return { platform, registered };
}

describe("a B01 robot registers with the rooms that arrive at start", () => {
  let robots;
  let platform;

  beforeEach(async () => {
    robots = await createB01Robots({
      robots: [{ duid: DUID, name: "Kitchen Q10", model: Q10_MODEL }],
      config: { enableMatterServiceArea: true },
    });
  });
  afterEach(() => {
    for (const vacuum of platform?.matterVacuums.values() ?? []) {
      vacuum.dispose();
    }
    robots.api.clearTimersAndIntervals();
    jest.useRealTimers();
  });

  test("a Q10 whose first map push arrives during discovery registers with its rooms", async () => {
    const setup = platformOver(robots.api);
    platform = setup.platform;
    const discovering = platform.discoverMatterVacuum({
      duid: DUID,
      name: "Kitchen Q10",
      pv: "B01",
      online: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await robots.mapPacket(DUID, buildQ10MapPacket({ rooms: ROOMS }));
    await discovering;

    expect(setup.registered).toHaveLength(1);
    expect(
      setup.registered[0].clusters.serviceArea?.supportedAreas.map(
        (area) => area.areaId
      )
    ).toEqual([9, 3]);
  });

  test("a robot whose rooms do not come is registered without them after a few seconds", async () => {
    const setup = platformOver(robots.api);
    platform = setup.platform;
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    let done = false;
    const discovering = platform
      .discoverMatterVacuum({
        duid: DUID,
        name: "Kitchen Q10",
        pv: "B01",
        online: true,
      })
      .then(() => {
        done = true;
      });
    await jest.advanceTimersByTimeAsync(7000);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    await discovering;
    expect(setup.registered).toHaveLength(1);
    expect(setup.registered[0].clusters.serviceArea).toBeUndefined();
  });

  test("a robot whose rooms are already known is not held back", async () => {
    await robots.api.setB01RoomCache(DUID, [{ roomId: 9, roomName: "Stue" }]);
    let waited = true;
    void robots.api.waitForFirstB01Rooms(DUID).then(() => {
      waited = false;
    });
    await Promise.resolve();
    expect(waited).toBe(false);
  });

  test("an offline robot is not held back", async () => {
    robots.homeData.devices[0].online = false;
    await robots.api.setStateAsync("HomeData", {
      val: JSON.stringify(robots.homeData),
      ack: true,
    });
    expect(robots.api.getVacuumDeviceInfo(DUID, "online")).toBe(false);
    let waited = true;
    void robots.api.waitForFirstB01Rooms(DUID).then(() => {
      waited = false;
    });
    await Promise.resolve();
    expect(waited).toBe(false);
  });
});
