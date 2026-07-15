/**
 * End-to-end simulation of the user's exact setup: two B01/Q7 robots
 * ("Garage", "1. Sal") plus one classic a70 ("Stueetage").
 *
 * Everything real except the cloud transport: real createDevices, real
 * dedicated B01 status loop under fake timers, real map decode against the
 * reference-generated fixture, real Matter accessories with a capturing
 * matter API. Asserts the full user-visible chain: battery follows the
 * robot, and the Apple Home tile switches between Charging and Docked.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const MAP_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "testdata", "b01_q7_map_fixture.json"),
    "utf8"
  )
);

const GARAGE = "duid-garage";
const FIRST_FLOOR = "duid-1sal";
const CLASSIC = "duid-a70";

function createLog() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function buildHomeData() {
  // Note: both Q7s use the fixture serial so the REAL map-key derivation and
  // decode chain can run for both (the fixture payload is bound to one SN).
  return {
    products: [
      {
        id: "product-sc05",
        model: "roborock.vacuum.sc05",
        schema: [
          { id: 120, code: "error_code" },
          { id: 121, code: "state" },
          { id: 122, code: "battery" },
        ],
      },
      {
        id: "product-a70",
        model: "roborock.vacuum.a70",
        schema: [
          { id: 120, code: "error_code" },
          { id: 121, code: "state" },
          { id: 122, code: "battery" },
          { id: 123, code: "fan_power" },
        ],
      },
    ],
    devices: [
      {
        duid: GARAGE,
        name: "Garage",
        productId: "product-sc05",
        pv: "B01",
        sn: MAP_FIXTURE.serial,
        online: true,
        // Realistic stale cloud snapshot (pairing-day values): the live
        // channel must win over this in every publish.
        deviceStatus: { 121: 1, 122: 74 },
      },
      {
        duid: FIRST_FLOOR,
        name: "1. Sal",
        productId: "product-sc05",
        pv: "B01",
        sn: MAP_FIXTURE.serial,
        online: true,
        deviceStatus: { 121: 1, 122: 74 },
      },
      {
        duid: CLASSIC,
        name: "Stueetage",
        productId: "product-a70",
        pv: "1.0",
        sn: "R52EBS31400216",
        online: true,
        deviceStatus: { 121: 8, 122: 100 },
      },
    ],
    receivedDevices: [],
    rooms: [],
  };
}

describe("Full-chain simulation: two Q7s + one classic robot", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("battery follows the robot and the tile switches Charging -> Docked", async () => {
    jest.useFakeTimers();

    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-e2e-")),
      enableMatterServiceArea: true,
    });

    const homeData = buildHomeData();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify(homeData),
      ack: true,
    });
    api.devices = api.getAllHomeDevices();

    // Scriptable robot cloud: per-device battery/status, adjustable mid-test.
    const robotState = {
      // fault 407 is the informational "scheduled cleanup ignored" code both
      // field robots reported while healthy — it must not disturb anything.
      [GARAGE]: { status: 4, quantity: 74, fault: 407, wind: 2 },
      [FIRST_FLOOR]: { status: 1, quantity: 88, fault: 407, wind: 2 },
    };
    api.messageQueueHandler = {
      sendRequest: jest.fn(async (duid, method) => {
        if (method === "get_status") {
          return { ...robotState[duid] };
        }
        if (method === "get_map_list") {
          return { map_list: [{ id: 1, cur: true }] };
        }
        if (method === "get_network_info") {
          return {};
        }
        return null;
      }),
    };
    api.sendB01MapRequest = jest.fn(async () =>
      Buffer.from(MAP_FIXTURE.payloadBase64, "ascii")
    );
    // v1 runtime networking is out of scope here.
    api.getNetworkInfo = jest.fn(async () => undefined);

    // Real platform dispatch + real Matter accessories with a capturing API.
    const matterUpdates = [];
    const platform = {
      platformConfig: {
        enableMatter: true,
        enableMatterServiceArea: true,
        enableMatterCleanMode: true,
        enableMatterChargingDockedStates: true,
        matterChargedBatteryThreshold: 90,
      },
      log: createLog(),
      getMatterApi: () => ({
        updateAccessoryState: async (uuid, cluster, attributes) => {
          matterUpdates.push({ uuid, cluster, attributes });
        },
      }),
      shouldAcceptUnscopedLiveMessage: () => false,
      roborockAPI: api,
    };

    const accessories = new Map();
    for (const device of homeData.devices.filter((d) => d.pv === "B01")) {
      const accessory = { UUID: `uuid-${device.duid}`, context: { duid: device.duid } };
      accessories.set(
        device.duid,
        new RoborockMatterVacuumAccessory(platform, accessory, device, true)
      );
    }
    api.setDeviceNotify((id, message) => {
      const vacuum = accessories.get(message?.duid);
      if (vacuum) {
        void vacuum.notifyDeviceUpdater(id, message);
      }
    });

    // ---- Boot: the real createDevices + initializeDeviceUpdates,
    // exactly like the login flow ----
    await api.createDevices();
    await api.initializeDeviceUpdates();

    // The dedicated loop must start regardless of device ordering.
    expect(api.b01StatusLoopHandle).toBeTruthy();
    // Rooms were fetched through the REAL decode chain and cached.
    expect(api.getRoomMappingsForDevice(GARAGE)).toEqual(
      MAP_FIXTURE.expectedRooms.map((room) => ({
        segmentId: room.roomId,
        mapId: 0,
        name: room.roomName,
      }))
    );

    // ---- First loop tick: both Q7s report in ----
    await jest.advanceTimersByTimeAsync(15100);

    function lastFor(duid, cluster) {
      return [...matterUpdates]
        .reverse()
        .find((u) => u.uuid === `uuid-${duid}` && u.cluster === cluster);
    }

    // Boot resync: the very first powerSource publishes are the nudge
    // (unknown) followed by the real value — this is what forces stuck
    // controller caches to receive a fresh report.
    const garagePowerSeq = matterUpdates.filter(
      (u) => u.uuid === `uuid-${GARAGE}` && u.cluster === "powerSource"
    );
    expect(garagePowerSeq[0].attributes.batPercentRemaining).toBeNull();
    expect(garagePowerSeq[1].attributes.batPercentRemaining).toBe(148);

    const garagePower = lastFor(GARAGE, "powerSource");
    expect(garagePower.attributes.batPercentRemaining).toBe(148); // 74% in half-percent units
    expect(lastFor(GARAGE, "rvcOperationalState").attributes.operationalState).toBe(
      65 // Charging: status 4 at 74% under the 90% threshold
    );

    const firstFloorPower = lastFor(FIRST_FLOOR, "powerSource");
    expect(firstFloorPower.attributes.batPercentRemaining).toBe(176); // 88%
    expect(
      lastFor(FIRST_FLOOR, "rvcOperationalState").attributes.operationalState
    ).toBe(0); // Stopped/Ready: waiting_for_orders

    // First-success visibility lines, one per robot, at INFO level.
    const infoLines = api.log.info.mock.calls.map((call) => call[0]);
    expect(
      infoLines.filter((line) => line.includes("B01 status online for"))
    ).toHaveLength(2);

    // ---- The robot finishes charging: cloud now reports 100% ----
    robotState[GARAGE] = { status: 4, quantity: 100, fault: 407, wind: 2 };
    matterUpdates.length = 0;

    // Past the 45s attempt gap, the next tick refreshes.
    await jest.advanceTimersByTimeAsync(46000);

    expect(lastFor(GARAGE, "powerSource").attributes.batPercentRemaining).toBe(
      200 // 100%
    );
    expect(
      lastFor(GARAGE, "rvcOperationalState").attributes.operationalState
    ).toBe(66); // Docked: still on charger, battery at/above the 90% threshold

    // ---- Room clean from Matter: the progress pill gets real data ----
    const garageVacuum = accessories.get(GARAGE);
    garageVacuum.selectedServiceAreaIds = [MAP_FIXTURE.expectedRooms[0].roomId];
    // The robot starts cleaning; the post-command refresh publishes the full
    // cluster snapshot (including service area progress) shortly after.
    robotState[GARAGE] = { status: 5, quantity: 98, fault: 407, wind: 2 };
    matterUpdates.length = 0;
    await garageVacuum.changeRunMode(1); // RUN_MODE_CLEANING
    await jest.advanceTimersByTimeAsync(6000);

    const areaPublish = [...matterUpdates]
      .reverse()
      .find((u) => u.uuid === `uuid-${GARAGE}` && u.cluster === "serviceArea");
    expect(areaPublish.attributes.currentArea).toBe(
      MAP_FIXTURE.expectedRooms[0].roomId
    );
    expect(areaPublish.attributes.progress).toEqual([
      { areaId: MAP_FIXTURE.expectedRooms[0].roomId, status: 1 },
    ]);

    // Robot returns to the charger: the run is reported completed.
    robotState[GARAGE] = { status: 4, quantity: 100, fault: 407, wind: 2 };
    await jest.advanceTimersByTimeAsync(46000);
    const donePublish = [...matterUpdates]
      .reverse()
      .find((u) => u.uuid === `uuid-${GARAGE}` && u.cluster === "serviceArea");
    expect(donePublish.attributes.currentArea).toBeNull();
    expect(donePublish.attributes.progress).toEqual([
      { areaId: MAP_FIXTURE.expectedRooms[0].roomId, status: 3 },
    ]);

    api.clearTimersAndIntervals();
  });
});
