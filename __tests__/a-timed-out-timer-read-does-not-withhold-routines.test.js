"use strict";

// The schedule coordinator reads two sources: the robot's device-side timer
// list (`get_server_timer`, over MQTT) and the account's Routines
// (`user/scene/device/{duid}`, REST). When the timer read TIMED OUT — the #24
// pattern of cloud requests going unanswered while MQTT says it is up — on
// the first reading after a restart, the whole reading was vetoed: the
// Routines that had been read were thrown away with it, so no Routine switch
// and no Routine schedule switch appeared, the platform dropped the
// coordinator, and nothing read again until the next restart.
//
// Each source is now applied on its own: a source that failed keeps exactly
// the switches of its own kind, the Routines depend on the scene reading
// only, and a coordinator whose reading was incomplete keeps reading, with
// the existing back-off, until it is complete. The platform publishes the
// schedule accessory whenever a reading leaves it with switches.

jest.mock("mqtt");

const axios = require("axios");
const mqtt = require("mqtt");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  advanceUntil,
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  robot,
  useFakeTimersAroundRealIo,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");
const {
  PlatformAccessory,
  hap,
  makeScheduleAccount,
  makeSchedulePlatform,
  scene,
  switchSubtypes,
} = require("../test-support/schedule-account");
const scheduleModule = require("../src/hap_schedule_accessory.ts");
const RoborockHapScheduleAccessory = scheduleModule.default;
const { ScheduleAccountCoordinator } = scheduleModule;
const RoborockPlatform = require("../src/platform").default;

const DUID = "duid-s8";
const TIMER_200 = ["200", "on", ["0 9 * * 1", ["start_clean", 106]]];

function accessoryNamed(name, seed) {
  return new PlatformAccessory(name, hap.uuid.generate(seed));
}

describe("against the real request queue and a fake Roborock server", () => {
  let cloud;
  let api;

  beforeAll(async () => {
    cloud = await startFakeRoborockCloud({
      homeData: homeData({ devices: [robot(DUID, "Rocky")] }),
      scenes: {
        [DUID]: [
          scene({ id: 1, name: "Morning", duid: DUID }),
          scene({ id: 2, name: "Kitchen now", duid: DUID, timer: false }),
        ],
      },
    });
    cloud.trust();
  });

  afterAll(async () => {
    await cloud.close();
  });

  beforeEach(async () => {
    mqtt.connect.mockImplementation(() => fakeMqttClient());
    useFakeTimersAroundRealIo();
    api = createAdapterOnFakeCloud(cloud, { userData: cloud.issueSession() });
    await api.startService();
    await waitFor(() => api.isInited(), "the start");
    await waitFor(
      () => api.rr_mqtt_connector.isConnected(),
      "the MQTT session"
    );
  });

  afterEach(async () => {
    await api.stopService();
    jest.useRealTimers();
  });

  test("a get_server_timer timeout does not withhold the Routines, and the timers are read again", async () => {
    const platform = makeSchedulePlatform(api);
    const manager = accessoryNamed("Rocky Schedules", "schedules");
    const routines = accessoryNamed("Rocky Routines", "routines");
    const coordinator = new RoborockHapScheduleAccessory(
      platform,
      manager,
      DUID,
      new ScheduleAccountCoordinator()
    );
    const routineCounts = [];
    coordinator.attachRoutineAccessory(routines, (count) =>
      routineCounts.push(count)
    );

    let result;
    coordinator.initialize("Rocky").then((value) => (result = value));
    // The robot never answers: the request queue's own 10 s timeout.
    await advanceUntil(cloud, () => result !== undefined, "the first reading");

    expect(platform.log.warn.mock.calls.join("\n")).toMatch(
      /get_server_timer timed out after 10 seconds/
    );
    expect(result.success).toBe(true);
    expect(routineCounts).toEqual([2]);
    expect(switchSubtypes(manager)).toEqual([
      `roborock-schedule-${encodeURIComponent("scene:1")}`,
    ]);

    // The robot answers the next time; nobody had to open the Home app.
    jest.spyOn(api, "getServerTimers").mockResolvedValue([TIMER_200]);
    await advanceUntil(
      cloud,
      () => switchSubtypes(manager).includes("roborock-schedule-200"),
      "the timers to be read again"
    );
    expect(routineCounts.at(-1)).toBe(2);
    coordinator.shutdown();
  });
});

describe("in the platform", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a first reading that fails as a whole is retried, and the accessory is published when it succeeds", async () => {
    // A real network failure, not a made-up message.
    const refused = await axios
      .get("https://127.0.0.1:9/", { timeout: 1000 })
      .catch((error) => error);
    const account = makeScheduleAccount({ duid: DUID });
    let fail = true;
    account.getServerTimers.mockImplementation(async () => {
      if (fail) throw refused;
      return [TIMER_200];
    });
    account.getCloudScenes.mockImplementation(async () => {
      if (fail) throw refused;
      return [];
    });

    const platform = Object.create(RoborockPlatform.prototype);
    Object.assign(platform, makeSchedulePlatform(account), {
      platformConfig: {
        enableHomeKitActionSwitches: true,
        enableHomeKitScheduleSwitches: true,
      },
      accessories: [],
      hapScheduleAccessories: new Map(),
      schedulePolicyLogged: true,
    });
    platform.api = {
      ...platform.api,
      platformAccessory: PlatformAccessory,
      registerPlatformAccessories: jest.fn(),
      unregisterPlatformAccessories: jest.fn(),
    };
    platform.getVacuumDisplayName = () => "Rocky";

    platform.syncHapSchedules([{ duid: DUID }]);
    await jest.advanceTimersByTimeAsync(0);

    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
    // Kept, because it is still trying.
    expect(platform.hapScheduleAccessories.has(DUID)).toBe(true);

    fail = false;
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(platform.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    const [[, , [registered]]] =
      platform.api.registerPlatformAccessories.mock.calls;
    expect(switchSubtypes(registered)).toEqual(["roborock-schedule-200"]);
    platform.hapScheduleAccessories.get(DUID).shutdown();
  });
});
