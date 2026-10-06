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
  // YXDeviceState -> the v1 state with the same meaning (same number).
  test.each([
    ["sleeping", 2, 2],
    ["idle", 3, 3],
    ["cleaning", 5, 5],
    ["returning home", 6, 6],
    ["charging", 8, 8],
    ["paused", 10, 10],
  ])("YXDeviceState %s (%i) is v1 state %i", async (_name, raw, v1) => {
    const api = await q10Api(raw);
    expect(Number(api.getVacuumDeviceStatus(Q10, "state"))).toBe(v1);
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

describe("a Q10's run sub-states are a run, not v1's offline/locked", () => {
  test.each([
    ["sweeping", 102, 5],
    ["mopping", 103, 5],
    ["sweep and mop", 104, 5],
    ["waiting to charge", 108, 8],
  ])(
    "pushed YXDeviceState %s (%i) normalises to v1 state %i",
    async (_name, raw, v1) => {
      const api = await q10Api(8);
      expect(api.normalizePushedState(Q10, raw)).toBe(v1);
    }
  );

  test("a classic robot's pushed state is never touched", async () => {
    const api = await q10Api(8);
    api.isB01Q10Device = () => false;
    expect(api.normalizePushedState(Q10, 101)).toBe(101);
  });
});
