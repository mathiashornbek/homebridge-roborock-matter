"use strict";

/**
 * #26: one more "refill the water tank" on every Homebridge restart.
 *
 * The reporter's own log has the pair within one second of a start:
 *
 *   Matter publish for Roborock Qrevo S: … operationalState=66 …
 *   Matter publish for Roborock Qrevo S: … operationalState=66 … fault=68
 *
 * Homebridge 2.4.0 restores nothing for an external Matter accessory: its
 * cache is loaded only after the accessory has registered (ServerLifecycle
 * runServer -> startServerNode), so the endpoint starts from the
 * `accessory.clusters` the plugin builds in the constructor. Those were built
 * from the cloud's HomeData snapshot, which has no tank field, so the store
 * started without the fault and the first live status raised it — and matter.js
 * emits the OperationalError event on every raise.
 *
 * The robot's first status is already known by then: startup waits up to four
 * seconds for each classic robot's first `get_status` before the accessories
 * register. It was dropped because no accessory existed yet, and only B01 kept
 * a copy. Kept for classic robots too, and read before the registration
 * defaults are built, the endpoint starts in the state matter.js would hold
 * after the raise — Error, with the fault — and matter.js emits nothing for an
 * initial value.
 *
 * Real platform discovery, real Roborock API with its real `get_status` poll
 * (lib/vacuum.js), the a144's own docked reply with an empty clean tank (#22),
 * and the matter.js 0.17.9 replay created from the clusters the accessory
 * registers with.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const RoborockPlatform = require("../src/platform").default;
const { Roborock } = require("../roborockLib/roborockAPI");
const { vacuum: VacuumClass } = require("../roborockLib/lib/vacuum");
const { deviceFeatures } = require("../roborockLib/lib/deviceFeatures");
const { createMatterStore } = require("../test-support/matter-0.17.9-store");
const { V1_PRODUCT_SCHEMA } = require("../test-support/real-api-matter-vacuum");
const { CAPTURES } = require("../test-support/a144-vacuum-harness");

const DUID = "device-restart";
const WATER_TANK_EMPTY = 68;
const ERROR = 3;
// Keep the captured dock fault; add an onboard shortage so BOTH water
// supplies are empty under the Matter blocking policy. The original capture
// has shortage 0 and still drives the independent HAP sensor tests.
const DOCKED_TANK_EMPTY = {
  ...CAPTURES.run1_1748_dockedBothTanksFlagged.reply[0],
  water_shortage_status: 1,
};

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

async function createRoborockApi() {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "restart-")),
  });
  // The a144's HomeData snapshot (#22): schema ids only, no tank field.
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      products: [
        {
          id: "product-a144",
          model: "roborock.vacuum.a144",
          schema: V1_PRODUCT_SCHEMA,
        },
      ],
      devices: [
        {
          duid: DUID,
          name: "Rocky",
          productId: "product-a144",
          pv: "1.0",
          online: true,
          deviceStatus: { 120: 0, 121: 8, 122: 100, 133: 1 },
        },
      ],
      receivedDevices: [],
    }),
    ack: true,
  });
  api.bInited = true;
  return api;
}

/** The robot's first status, polled the way startup polls it. */
async function pollFirstStatus(api, reply) {
  const robot = new VacuumClass(api, "roborock.vacuum.a144");
  robot.features = new deviceFeatures(api, 0, 0, DUID);
  api.vacuums[DUID] = robot;
  api.messageQueueHandler.sendRequest = jest.fn(async () => [
    JSON.parse(JSON.stringify(reply)),
  ]);
  await robot.getParameter(DUID, "get_status", "force");
}

function createPlatform(api) {
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
  platform.roborockAPI = api;

  const homebridge = { store: null };
  const matterApi = {
    deviceTypes: { RoboticVacuumCleaner: "rvc" },
    // Homebridge 2.4.0 registers an external accessory with its clusters as
    // the endpoint's initial state, and restores nothing over them.
    registerPlatformAccessories: jest.fn(async (_plugin, _platform, list) => {
      homebridge.store = createMatterStore(list[0].clusters);
    }),
    updatePlatformAccessories: jest.fn(async () => undefined),
    updateAccessoryState: (...args) =>
      homebridge.store.updateAccessoryState(...args),
    getAccessoryState: (...args) => homebridge.store.getAccessoryState(...args),
  };
  platform.getMatterApi = () => matterApi;
  api.setDeviceNotify((id, data) =>
    platform.matterVacuums.get(DUID)?.notifyDeviceUpdater(id, data)
  );
  return { platform, homebridge };
}

async function startHomebridge({ firstStatus }) {
  const api = await createRoborockApi();
  if (firstStatus) {
    await pollFirstStatus(api, firstStatus);
  }
  const { platform, homebridge } = createPlatform(api);

  await platform.discoverMatterVacuum({
    duid: DUID,
    name: "Rocky",
    pv: "1.0",
    online: true,
  });
  const vacuum = platform.matterVacuums.get(DUID);
  // The refresh discovery schedules for one second later, and the next poll.
  await vacuum.updateMatterStateFromRoborock();
  await api.deviceNotify("LocalMessage", {
    duid: DUID,
    payload: [JSON.parse(JSON.stringify(DOCKED_TANK_EMPTY))],
  });
  return { api, vacuum, store: homebridge.store };
}

let started = [];
afterEach(() => {
  for (const vacuum of started) {
    vacuum.dispose();
  }
  started = [];
  jest.restoreAllMocks();
});

describe("a restart does not repeat a standing tank warning", () => {
  test("the robot's first get_status is kept for a classic robot", async () => {
    const api = await createRoborockApi();

    await pollFirstStatus(api, DOCKED_TANK_EMPTY);

    expect(api.getLastKnownLiveStatus(DUID)).toEqual(DOCKED_TANK_EMPTY);
  });

  test("an endpoint registered after the first status starts with the fault, and nothing is announced", async () => {
    const { vacuum, store } = await startHomebridge({
      firstStatus: DOCKED_TANK_EMPTY,
    });
    started.push(vacuum);

    expect(store.read("rvcOperationalState", "operationalError")).toEqual({
      errorStateId: WATER_TANK_EMPTY,
    });
    expect(store.read("rvcOperationalState", "operationalState")).toBe(ERROR);
    expect(store.events).toEqual([]);
  });

  test("a robot that had not answered before registration still raises it once — the path that remains", async () => {
    const { vacuum, store } = await startHomebridge({ firstStatus: null });
    started.push(vacuum);

    expect(store.read("rvcOperationalState", "operationalError")).toEqual({
      errorStateId: WATER_TANK_EMPTY,
    });
    expect(store.events).toHaveLength(1);
  });
});
