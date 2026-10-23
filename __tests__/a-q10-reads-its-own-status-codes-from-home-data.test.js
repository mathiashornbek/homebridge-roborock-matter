"use strict";

/**
 * Issue #33, the Q10 S5 half: `operationalState` flapping 0 / 66 / 2 / 0 / 64
 * within seconds on a robot sitting in its dock.
 *
 * A Q10 (`roborock.vacuum.ss07`) has two sources for its state, and they read
 * the SAME datapoint (121, `dpStatus`) with two DIFFERENT tables:
 *
 *  - pushed datapoints (`{"dps":{"121":8,"122":100}}`, the reporter's own
 *    diagnostic) go through extractStatusUpdate(), which reads 121 as a v1
 *    state — 8 = Charging -> Docked (66) at 100 %;
 *  - the home-data snapshot goes through getVacuumDeviceStatus(), which for
 *    every `pv === "B01"` robot translates 121 with the Q7 work-status table
 *    (b01Q7Adapter B01_STATUS_TO_V1_STATE) — 8 -> 3 -> Stopped (0).
 *
 * The Q10 dialect's status enum is python-roborock's
 * `roborock/data/b01_q10/b01_q10_code_mappings.py` YXDeviceState:
 * 2 sleeping, 3 idle, 5 cleaning, 6 returning home, 8 charging, 10 paused,
 * 12 error — the v1 numbering, not the Q7 one. Through the Q7 table a
 * sleeping Q10 becomes Paused (runMode Cleaning), an idle one becomes Docking
 * (SeekingCharger 64), a charging one Stopped. The home-data path is what
 * every restart publishes first, and what a quiet robot falls back to once
 * its live cache is 15 minutes old.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const Q10 = "duid-q10";

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

async function q10Api(dpStatus) {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "q10-home-data-")),
  });
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      products: [
        {
          id: "product-ss07",
          model: "roborock.vacuum.ss07",
          schema: [
            { id: 121, code: "state" },
            { id: 122, code: "battery" },
          ],
        },
      ],
      devices: [
        {
          duid: Q10,
          name: "Roborock Q10 S5",
          productId: "product-ss07",
          pv: "B01",
          online: true,
          deviceStatus: { 121: dpStatus, 122: 100 },
        },
      ],
      receivedDevices: [],
      rooms: [],
    }),
    ack: true,
  });
  api.devices = api.getAllHomeDevices();
  return api;
}

describe("a Q10 reads its own status codes from home data (#33)", () => {
  // One row per python-roborock YXDeviceState member, so the table can be
  // diffed against the reference line by line. Both sources read it: the
  // home-data snapshot and a pushed datapoint 121.
  const YX_DEVICE_STATE_TO_V1 = [
    ["SLEEPING", 2, 2],
    ["IDLE", 3, 3],
    ["CLEANING", 5, 5],
    ["RETURNING_HOME", 6, 6],
    ["REMOTE_CONTROL_ACTIVE", 7, 7],
    ["CHARGING", 8, 8],
    ["PAUSED", 10, 10],
    ["ERROR", 12, 12],
    ["UPDATING", 14, 14],
    ["EMPTYING_THE_BIN", 22, 22],
    ["MAPPING", 29, 29],
    ["SAVING_MAP", 99, 5],
    ["RELOCATING", 101, 5],
    ["SWEEPING", 102, 5],
    ["MOPPING", 103, 5],
    ["SWEEP_AND_MOP", 104, 5],
    ["TRANSITIONING", 105, 5],
    ["WAITING_TO_CHARGE", 108, 8],
  ];

  test("every YXDeviceState reads as the v1 state with its meaning, from home data and from a push", async () => {
    const { mapDpsToV1 } = require("../roborockLib/lib/b01Q10Adapter");
    for (const [name, raw, v1] of YX_DEVICE_STATE_TO_V1) {
      const api = await q10Api(raw);
      expect([name, Number(api.getVacuumDeviceStatus(Q10, "state"))]).toEqual([
        name,
        v1,
      ]);
      expect([name, mapDpsToV1({ 121: raw }).state]).toEqual([name, v1]);
    }
  });

  test("home data and the robot's own push agree on a Q10 charging in its dock", async () => {
    const api = await q10Api(8);
    let store;
    const platform = {
      log: createLog(),
      platformConfig: { enableMatter: true },
      getMatterApi: () => ({
        updateAccessoryState: (...args) => store.updateAccessoryState(...args),
      }),
      shouldAcceptUnscopedLiveMessage: () => false,
      roborockAPI: api,
    };
    const accessory = { UUID: "uuid-q10", context: { duid: Q10 } };
    const device = api.devices.find((d) => d.duid === Q10);
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      device,
      true
    );
    store = createMatterStore(accessory.clusters);

    // What every restart publishes first: the home-data snapshot.
    await vacuum.updateMatterStateFromRoborock();
    const fromHomeData = store.read("rvcOperationalState", "operationalState");

    // The datapoint frame from the reporter's diagnostic, same robot, same dock.
    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: Q10,
      payload: { dps: { 121: 8, 122: 100 } },
    });
    const fromPush = store.read("rvcOperationalState", "operationalState");
    vacuum.dispose();

    expect(fromPush).toBe(66); // Docked
    // Fails on 3.34.0: home data published Stopped (0) for the same robot.
    expect(fromHomeData).toBe(fromPush);
  });
});
