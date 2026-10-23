"use strict";

/**
 * A Matter vacuum accessory standing on a REAL `Roborock` API, the way
 * production wires it, with only the robot itself replaced.
 *
 * Most accessory tests stub `getVacuumDeviceStatus` with whatever field the
 * test needs. That is exactly how the plumbing gaps survived: a stub answers
 * `in_cleaning` or `water_box_mode` from "HomeData" when the real snapshot
 * cannot. Here HomeData is the cloud's own shape — `deviceStatus` keyed by the
 * product schema ids (python-roborock `RoborockDataProtocol` 120-135) — and the
 * real `getVacuumDeviceStatus` reads it, so a field the cloud snapshot does not
 * carry is unknown unless a live frame said it.
 *
 * Live frames are delivered through `api.deviceNotify("LocalMessage", …)`,
 * the call lib/localConnector.js makes with a reply's `result`. Commands go
 * through the real API down to `vacuums[duid].command`, which is the only
 * stand-in: it records the method and answers "ok".
 */

const fs = require("fs");
const {
  setImmediate: realSetImmediate,
  setTimeout: realSetTimeout,
} = require("node:timers");
const os = require("os");
const path = require("path");

const { Roborock } = require("../roborockLib/roborockAPI");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { createMatterStore } = require("./matter-0.17.9-store");

const DUID = "device-real-api";

/** Every accessory built here, so a test can stop their heartbeats. */
const created = [];

// The schema a classic v1 product carries in HomeData.
const V1_PRODUCT_SCHEMA = [
  { id: 120, code: "error_code" },
  { id: 121, code: "state" },
  { id: 122, code: "battery" },
  { id: 123, code: "fan_power" },
  { id: 124, code: "water_box_mode" },
  { id: 125, code: "main_brush_work_time" },
  { id: 126, code: "side_brush_work_time" },
  { id: 127, code: "filter_work_time" },
  { id: 128, code: "additional_props" },
  { id: 133, code: "charge_status" },
  { id: 134, code: "drying_status" },
];

const CODE_TO_SCHEMA_ID = Object.fromEntries(
  V1_PRODUCT_SCHEMA.map(({ id, code }) => [code, id])
);

/**
 * @param {{
 *   model?: string,
 *   homeData?: Record<string, number>,
 *   platformConfig?: Record<string, unknown>,
 *   rooms?: Array<{segmentId: number, name: string}>,
 *   savedContext?: Record<string, unknown>,
 * }} [options] `savedContext`: the accessory context Homebridge kept from
 *   the previous run (a restart)
 */
async function createRealApiVacuum({
  model = "roborock.vacuum.a70",
  homeData = {
    error_code: 0,
    state: 8,
    battery: 100,
    fan_power: 102,
    water_box_mode: 201,
    charge_status: 1,
  },
  platformConfig = {},
  rooms = [],
  savedContext = {},
} = {}) {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "real-api-vacuum-")),
  });

  const deviceStatus = {};
  for (const [code, value] of Object.entries(homeData)) {
    if (CODE_TO_SCHEMA_ID[code] === undefined) {
      throw new Error(`HomeData has no schema id for ${code}`);
    }
    deviceStatus[CODE_TO_SCHEMA_ID[code]] = value;
  }
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      products: [{ id: "product-v1", model, schema: V1_PRODUCT_SCHEMA }],
      devices: [
        {
          duid: DUID,
          name: "Rocky",
          productId: "product-v1",
          pv: "1.0",
          online: true,
          deviceStatus,
        },
      ],
      receivedDevices: [],
    }),
    ack: true,
  });

  if (rooms.length > 0) {
    // The shape roborockAPI.js keeps after get_room_mapping, on map 0.
    api.roomMappings[DUID] = {
      currentMapId: 0,
      maps: [{ mapId: 0, name: "Home" }],
      roomsByMap: {
        0: rooms.map((room) => ({ ...room, mapId: 0 })),
      },
    };
  }

  /** @type {string[]} */
  const commands = [];
  api.bInited = true;
  api.vacuums[DUID] = {
    command: jest.fn(async (_duid, method) => {
      commands.push(method);
      return ["ok"];
    }),
    getParameter: jest.fn(async () => undefined),
  };

  let store;
  const platform = {
    platformConfig: { enableMatter: true, ...platformConfig },
    log,
    getMatterApi: () => store,
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: api,
  };
  const accessory = {
    UUID: "uuid-real-api",
    context: { ...savedContext, duid: DUID },
  };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: DUID },
    true
  );
  // Homebridge registers the endpoint with accessory.clusters as defaults.
  store = createMatterStore(accessory.clusters);
  api.setDeviceNotify((id, data) => vacuum.notifyDeviceUpdater(id, data));
  created.push(vacuum);

  return {
    api,
    vacuum,
    store,
    accessory,
    log,
    commands,
    duid: DUID,
    /** A `get_status` reply as lib/localConnector.js hands it on. */
    async localReply(status) {
      await api.deviceNotify("LocalMessage", {
        duid: DUID,
        payload: [JSON.parse(JSON.stringify(status))],
      });
    },
    /**
     * Let deferred publishes (a 0 ms timer) and dispatched commands run. The
     * real timers on purpose: a 0 ms timer can outlast a few setImmediate
     * turns, and a test on fake timers advances them itself.
     */
    async settle() {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => realSetImmediate(resolve));
        await new Promise((resolve) => realSetTimeout(resolve, 2));
      }
    },
  };
}

/** Stop every accessory's timers; call from afterEach. */
function disposeRealApiVacuums() {
  for (const vacuum of created.splice(0)) {
    vacuum.dispose();
  }
}

module.exports = {
  createRealApiVacuum,
  disposeRealApiVacuums,
  V1_PRODUCT_SCHEMA,
};
