"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const { vacuum } = require("../roborockLib/lib/vacuum");
const RRMapParser = require("../roborockLib/lib/RRMapParser");
const {
  DEFAULT_REQUEST_POLICY,
  LOCAL_SERVER_REQUEST_POLICY,
  resolveRequestPolicy,
} = require("../roborockLib/lib/requestPolicy");
const { loadSettingsPage } = require("../test-support/settings-page");
const { createFakeHomebridge } = require("../test-support/fake-homebridge");
const RoborockPlatform = require("../src/platform").default;

const SERVER = "https://api-roborock.example.com:555";
const localSession = () => ({
  rriot: {
    r: {
      a: SERVER,
      m: "ssl://mqtt-roborock.example.com:8881",
    },
  },
});
const enabled = { serverURL: SERVER, enableLocalServerFastRefresh: true };
const storagePaths = [];
const adapters = [];
let now;

function storagePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-refresh-"));
  storagePaths.push(dir);
  return dir;
}

function makeApi(options = {}) {
  const api = new Roborock({
    ...enabled,
    userData: localSession(),
    storagePath: storagePath(),
    log: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    ...options,
  });
  adapters.push(api);
  return api;
}

beforeEach(() => {
  now = 1_800_000_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(async () => {
  for (const api of adapters.splice(0)) await api.stopService();
  jest.restoreAllMocks();
  for (const dir of storagePaths.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the local preset is opt-in and follows the authenticated routes", () => {
  test.each([undefined, false, "true", 1])(
    "a flag of %s keeps ordinary rates even on a local server",
    (flag) => {
      expect(
        resolveRequestPolicy(
          { ...enabled, enableLocalServerFastRefresh: flag },
          localSession()
        )
      ).toBe(DEFAULT_REQUEST_POLICY);
    }
  );

  test("accepts a custom domain with separate HTTPS and MQTT ports", () => {
    expect(resolveRequestPolicy(enabled, localSession())).toBe(
      LOCAL_SERVER_REQUEST_POLICY
    );
  });

  test.each([
    undefined,
    "",
    "not-a-url",
    "http://localhost:555",
    `${SERVER}/api`,
    "https://usiot.roborock.com",
    "https://USIOT.ROBOROCK.COM.",
  ])("the server setting %s cannot enable the preset", (serverURL) => {
    expect(
      resolveRequestPolicy({ ...enabled, serverURL }, localSession())
    ).toBe(DEFAULT_REQUEST_POLICY);
  });

  test.each([
    ["a", "https://api-us.roborock.com"],
    ["m", "ssl://mqtt-us.roborock.com:8883"],
    ["m", "ssl://MQTT-US.ROBOROCK.COM.:8883"],
    ["m", undefined],
    ["a", undefined],
    ["a", "bad-url"],
    ["m", "https://mqtt-roborock.example.com"],
  ])("rejects a stale, mixed or missing %s route: %s", (key, value) => {
    const session = localSession();
    session.rriot.r[key] = value;
    expect(resolveRequestPolicy(enabled, session)).toBe(DEFAULT_REQUEST_POLICY);
  });

  test("takes effect after the session loads and resets when it is removed", () => {
    const api = makeApi({ userData: null });
    expect(api.getRequestPolicy()).toBe(DEFAULT_REQUEST_POLICY);
    api.userData = localSession();
    expect(api.getRequestPolicy()).toBe(LOCAL_SERVER_REQUEST_POLICY);
    api.userData = null;
    expect(api.getRequestPolicy()).toBe(DEFAULT_REQUEST_POLICY);
  });
});

function statusRobot(api) {
  api.messageQueueHandler.sendRequest = jest.fn(async () => [
    { state: 8, battery: 98 },
  ]);
  api.getObjectAsync = jest.fn(async () => ({}));
  api.setStateAsync = jest.fn(async () => undefined);
  api.updateRoborockDiagnostics = jest.fn(async () => undefined);
  api.isCleaning = jest.fn(() => false);
  const robot = new vacuum(api, "roborock.vacuum.a27");
  robot.features = { hasDeviceStatusAttribute: () => true };
  api.vacuums["one"] = robot;
  api.vacuums["two"] = robot;
  return robot;
}

describe("real read paths use the preset", () => {
  test.each([
    [true, 15_000],
    [false, 60_000],
  ])(
    "classic status with preset=%s uses a %sms gap per robot",
    async (on, gap) => {
      const api = makeApi({ enableLocalServerFastRefresh: on });
      const robot = statusRobot(api);
      const read = (id = "one") =>
        robot.getParameter(id, "get_status", "state");
      await read();
      now += gap - 1;
      await read();
      expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
      await read("two");
      expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
      now += 1;
      await read();
      expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(3);
      await robot.getParameter("one", "get_status", "force");
      expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(4);
    }
  );

  test("the slow lane runs at the first 3-minute cycle past its 5-minute gap", async () => {
    const api = makeApi();
    api.getRobotVersion = async () => "1.0";
    api.refreshMatterServiceAreaRoomMappings = async () => true;
    api.pollParameter = jest.fn(async () => undefined);
    const robot = { features: { getFeatureList: () => ({}) } };
    api.vacuums.one = robot;
    const poll = () =>
      api.updateDataMinimumData("one", robot, "roborock.vacuum.a27");
    await poll();
    expect(api.pollParameter).toHaveBeenCalledWith(
      "one",
      robot,
      "get_consumable",
      false
    );
    api.pollParameter.mockClear();
    now += 180_000;
    await poll();
    expect(api.pollParameter).not.toHaveBeenCalled();
    now += 180_000;
    await poll();
    expect(api.pollParameter).toHaveBeenCalledWith(
      "one",
      robot,
      "get_consumable",
      false
    );
    api.config.enableLocalServerFastRefresh = false;
    api.pollParameter.mockClear();
    now += 180_000 * 2;
    await poll();
    expect(api.pollParameter).not.toHaveBeenCalled();
  });
});

function mapApi(options) {
  const api = makeApi(options);
  api.messageQueueHandler.sendRequest = jest.fn(async () => Buffer.alloc(1));
  jest
    .spyOn(RRMapParser, "resolveLiveSegmentFromMapBuffer")
    .mockReturnValue(16);
  api.getRoomMappingsForDevice = () => [{ segmentId: 16, name: "Kitchen" }];
  return api;
}

describe("faster live maps retain their guards", () => {
  test.each([
    [true, 5000],
    [false, 10000],
  ])("preset=%s permits the next map at %sms, not before", async (on, gap) => {
    const api = mapApi({ enableLocalServerFastRefresh: on });
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    now += gap - 1;
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    now += 1;
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
    expect(api.messageQueueHandler.sendRequest).toHaveBeenLastCalledWith(
      "one",
      "get_map_v1",
      [],
      true
    );
  });

  test("does not start a second map request while the first is pending", async () => {
    const api = mapApi();
    let answer;
    api.messageQueueHandler.sendRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const first = api.refreshClassicLiveRoom("one", { v1State: 5 });
    now += 15_000;
    const second = api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    answer(Buffer.alloc(1));
    await Promise.all([first, second]);
  });

  test("paused and docked robots cause no live-map requests", async () => {
    const api = mapApi();
    for (const v1State of [3, 8, 10, 15]) {
      await api.refreshClassicLiveRoom("one", { v1State });
      now += 10_000;
    }
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });

  test("an unanswered map keeps the 10s retry floor and six-strike breaker", async () => {
    const api = mapApi();
    api.messageQueueHandler.sendRequest.mockImplementation(async () => {
      throw Object.assign(new Error("map timed out after 10 seconds"), {
        unansweredRequest: true,
        transportWasUp: true,
      });
    });
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    now += 5000;
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      now += 10_000;
      await api.refreshClassicLiveRoom("one", { v1State: 5 });
    }
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(6);
    now += 5 * 60 * 60_000;
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(6);
    now += 60 * 60_000;
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(7);
  });

  test("turning live-room tracking off still suppresses map reads", async () => {
    const api = mapApi({ enableLiveRoomTracking: false });
    await api.refreshClassicLiveRoom("one", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });
});

describe("settings and platform wiring", () => {
  test("loads, saves and reloads the toggle; a cloud region disables it", async () => {
    const page = loadSettingsPage({
      email: "test@example.com",
      serverURL: SERVER,
    });
    await page.run("loadConfig()");
    const toggle = page.element("local-server-fast-refresh");
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    toggle.checked = true;
    await page.run("saveCredentials(false, {only: AUTO_SAVED_FIELDS})");
    expect(page.savedConfig().enableLocalServerFastRefresh).toBe(true);
    toggle.checked = false;
    await page.run("loadConfig()");
    expect(toggle.checked).toBe(true);
    expect(page.element("advanced-settings").open).toBe(true);
    page.element("base-url").value = "https://usiot.roborock.com";
    page.run("syncServerUrlRow()");
    expect(toggle.disabled).toBe(true);
    await page.run("saveCredentials(false, {only: AUTO_SAVED_FIELDS})");
    expect(page.savedConfig().enableLocalServerFastRefresh).toBe(false);
  });

  test("the platform keeps schedule caching, write spacing and background cadence unchanged", () => {
    const homebridge = createFakeHomebridge({ storagePath: storagePath() });
    const platform = new RoborockPlatform(
      homebridge.homebridgeLog,
      {
        platform: "RoborockVacuumPlatform",
        email: "test@example.com",
        ...enabled,
      },
      homebridge.api
    );
    const api = platform.roborockAPI;
    adapters.push(api);
    api.userData = localSession();
    expect(api.getRequestPolicy()).toBe(LOCAL_SERVER_REQUEST_POLICY);
    expect(api.updateInterval).toBe(180);
    expect(platform.scheduleAccountCoordinator.policy).toEqual({
      cacheTtlMs: 300_000,
      batchWindowMs: 500,
      writeSpacingMs: 500,
      throttleCooldownMs: 65 * 60_000,
    });
    api.vacuums.one = {};
    api.hasInitializedVacuum = () => true;
    api.getProductAttribute = () => "roborock.vacuum.a27";
    api.setInterval = jest.fn(() => null);
    api.startMainUpdateInterval("one", true);
    expect(api.setInterval.mock.calls[0][1]).toBe(180_000);
  });
});
