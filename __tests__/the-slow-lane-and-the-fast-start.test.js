const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// Measured before 3.28.0: a classic robot's periodic cycle issued 8 requests
// every 180 seconds - 160 an hour - for consumable hours, timers, carpet and
// water-box modes that change roughly once a week. And at startup the Matter
// accessories were not registered until that whole cycle had completed for
// every robot, serially, each request able to spend its full 10-second
// timeout. The tile displays none of those values; it displays get_status,
// which is on its own tick and untouched here.

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi(model, pv) {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "slow-lane-")),
    enableMatterServiceArea: true,
  });
  const sent = [];
  api.getRobotVersion = async () => pv;
  api.getProductAttribute = () => model;
  api.getVacuumDeviceInfo = (_d, a) =>
    a === "pv" ? pv : a === "model" ? model : "";
  api.hasInitializedVacuum = () => true;
  api.isSupportedVacuumModel = () => true;
  api.getB01RoomCache = () => [{ id: 1 }];
  api.refreshB01Rooms = async () => {};
  const vacuum = {
    getParameter: async (_d, p) => {
      sent.push(p);
    },
    features: { getFeatureList: () => ({ isCarpetSupported: true }) },
  };
  api.vacuums["d1"] = vacuum;
  api.pollParameter = async (_d, _v, p) => {
    sent.push(p);
  };
  return { api, vacuum, sent };
}

const ROOMS = ["get_multi_maps_list", "get_room_mapping"];
const SLOW = [
  "get_consumable",
  "get_server_timer",
  "get_timer",
  "get_carpet_mode",
  "get_carpet_clean_mode",
  "get_water_box_custom_mode",
];

describe("the slow lane", () => {
  test("the first cycle reads everything, so a fresh process still learns it all once", async () => {
    const { api, vacuum, sent } = createApi("roborock.vacuum.a70", "1.0");
    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");
    expect(sent).toEqual([...ROOMS, ...SLOW]);
  });

  test("the second cycle inside 30 minutes reads only the rooms", async () => {
    const { api, vacuum, sent } = createApi("roborock.vacuum.a70", "1.0");
    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");
    sent.length = 0;

    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");

    // 8 requests a cycle became 2. Rooms stay on every cycle on purpose: a
    // room the user renames in the Roborock app should reach Apple Home
    // within minutes, and that refresh already serves from cache first.
    expect(sent).toEqual(ROOMS);
  });

  test("after 30 minutes the slow lane runs again", async () => {
    const { api, vacuum, sent } = createApi("roborock.vacuum.a70", "1.0");
    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");
    api.lastSlowParameterPollAt.set("d1", Date.now() - 30 * 60 * 1000 - 1);
    sent.length = 0;

    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");

    expect(sent).toEqual([...ROOMS, ...SLOW]);
  });

  test("asking for a fresh read brings the whole lane forward", async () => {
    const { api, vacuum, sent } = createApi("roborock.vacuum.a70", "1.0");
    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");
    sent.length = 0;

    api.requestSlowParameterPoll("d1");
    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");

    expect(sent).toEqual([...ROOMS, ...SLOW]);
  });

  test("the stamp is per robot", async () => {
    const { api, vacuum, sent } = createApi("roborock.vacuum.a70", "1.0");
    api.vacuums["d2"] = vacuum;
    await api.updateDataMinimumData("d1", vacuum, "roborock.vacuum.a70");
    sent.length = 0;

    await api.updateDataMinimumData("d2", vacuum, "roborock.vacuum.a70");

    // A second robot's first cycle is still its first cycle.
    expect(sent).toEqual([...ROOMS, ...SLOW]);
  });
});

describe("the fast start", () => {
  function createStartupApi() {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "fast-start-")),
    });
    api.devices = [{ duid: "d1", online: true }];
    api.hasInitializedVacuum = () => true;
    api.getProductAttribute = () => "roborock.vacuum.a70";
    api.getVacuumDeviceInfo = (_d, a) => (a === "pv" ? "1.0" : "");
    api.isB01Device = () => false;
    api.vacuums["d1"] = {};
    return api;
  }

  test("registration does not wait for the parameter cycle", async () => {
    const api = createStartupApi();
    let releaseCycle;
    api.updateDataMinimumData = jest.fn(
      () => new Promise((resolve) => (releaseCycle = resolve))
    );
    api.getStatus = jest.fn().mockResolvedValue(undefined);

    const done = api.initializeDeviceUpdates();
    const settled = await Promise.race([
      done.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);

    // The cycle has not been released, and initialization is already over.
    expect(settled).toBe("settled");
    expect(api.updateDataMinimumData).toHaveBeenCalledTimes(1);
    releaseCycle();
    for (const v of Object.values(api.vacuums)) {
      api.clearInterval(v.getStatusIntervalHandle);
      api.clearInterval(v.mainUpdateIntervalHandle);
    }
  });

  test("but it does wait for one real status per classic robot", async () => {
    const api = createStartupApi();
    api.updateDataMinimumData = jest.fn().mockResolvedValue(undefined);
    let statusResolved = false;
    api.getStatus = jest.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            statusResolved = true;
            resolve();
          }, 30)
        )
    );

    await api.initializeDeviceUpdates();

    expect(api.getStatus).toHaveBeenCalledWith("d1");
    expect(statusResolved).toBe(true);
    for (const v of Object.values(api.vacuums)) {
      api.clearInterval(v.getStatusIntervalHandle);
      api.clearInterval(v.mainUpdateIntervalHandle);
    }
  });

  test("a robot that never answers cannot hold the others' tiles hostage", async () => {
    jest.useFakeTimers();
    const api = createStartupApi();
    api.updateDataMinimumData = jest.fn().mockResolvedValue(undefined);
    api.getStatus = jest.fn(() => new Promise(() => {}));

    const done = api.initializeDeviceUpdates();
    let finished = false;
    done.then(() => {
      finished = true;
    });

    await jest.advanceTimersByTimeAsync(3999);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(finished).toBe(true);

    for (const v of Object.values(api.vacuums)) {
      api.clearInterval(v.getStatusIntervalHandle);
      api.clearInterval(v.mainUpdateIntervalHandle);
    }
    jest.useRealTimers();
  });
});
