"use strict";

// Issue #22 (DSimeone1989, Saros 10R `roborock.vacuum.a144`, dock
// type 16) on 3.34.0. Every input below is a verbatim `get_status` reply or
// dps push from his two logs of 30 Sept, extracted into
// test-support/issue-22-a144-captures.json with the log line it came from.
//
// What the logs show: the dock reports ONE `dock_error_status` at a time, and
// the clean-water tank also lives in `dss` (python-roborock 7.12.0,
// roborock/data/v1/v1_containers.py:170-180): bits 2-3 clean water, bits 4-5
// dirty water, bits 10-11 cleaning fluid. On this dock 2 = OK, 1 = problem,
// 0 = not reported.
//
//   run 1 17:30:05  dss 2216 -> 2212   clean water 2 -> 1
//         17:31:05  dss 2212 -> 2196   dirty water 2 -> 1
//         17:31:50  dock_error_status 0 -> 39  (waste-water tank, not 38)
//   run 2 17:52:44  dss 2216, dock_error_status 0   (both tanks serviced)
//         18:19:55  dss 2212           clean water 2 -> 1
//         18:20:54  dock_error_status 38 -> Water Tank Empty closes
//
// `water_shortage_status` is 0 in all 126 replies (46 + 80). So run 1 did
// not fire the automation because 39 masked 38, not because of the cloud
// settings — both runs got every status as a cloud reply.

const {
  CAPTURES,
  createA144Vacuum,
  loggedAtToMs,
} = require("../test-support/a144-vacuum-harness");
const { HOMEKIT_STATE_SENSOR_KEYS } = require("../src/types");
const { getStateSensorDefinition } = require("../src/state_sensor_accessory");

describe("#22: the clean-water tank as the a144 reports it", () => {
  test.each([
    // Controls: these already pass on 3.34.0.
    ["run 2 18:20:54, dock_error_status 38", "run2_1820_cleanEmptyOnly", true],
    ["run 2 17:52:44, both tanks serviced", "run2_1752_afterRefill", false],
    ["run 1 17:13:50, startup, all OK", "run1_1713_startupAllOk", false],
  ])("%s", async (_label, capture, expected) => {
    const rocky = createA144Vacuum();
    await rocky.reply(capture);
    expect(rocky.sensor("waterTankEmpty")).toBe(expected);
  });

  test.each([
    [
      "run 1 17:31:50, cleaning: dss clean-water 1, dock_error_status 39",
      "run1_1731_dirtyFullMasksCleanEmpty",
    ],
    [
      "run 1 17:48:05, docked: dss clean-water 1, dock_error_status 39",
      "run1_1748_dockedBothTanksFlagged",
    ],
  ])(
    "a full dirty-water tank does not hide an empty clean one — %s",
    async (_label, capture) => {
      // FAILS on 3.34.0: isWaterTankEmpty() reads only dock_error_status === 38
      // and water_shortage_status, never dss, and the dock can only hold one
      // dock_error_status — 39 won.
      const rocky = createA144Vacuum();
      await rocky.reply(capture);
      expect(CAPTURES[capture].reply[0].dock_error_status).toBe(39);
      expect((CAPTURES[capture].reply[0].dss >> 2) & 3).toBe(1);
      expect(rocky.sensor("waterTankEmpty")).toBe(true);
    }
  );
});

describe("#22 / #26: the dirty-water and cleaning-fluid tanks have sensors", () => {
  // Feature contract, FAILS on 3.34.0. Key names are the proposal in the audit
  // report; the four settings files carry them through HOMEKIT_STATE_SENSOR_KEYS.
  test("both keys are offered", () => {
    expect(HOMEKIT_STATE_SENSOR_KEYS).toEqual(
      expect.arrayContaining(["dirtyWaterTankFull", "cleaningFluidEmpty"])
    );
    expect(getStateSensorDefinition("dirtyWaterTankFull")).toBeDefined();
    expect(getStateSensorDefinition("cleaningFluidEmpty")).toBeDefined();
  });

  test.each([
    ["run1_1731_dirtyFullMasksCleanEmpty", true, false],
    ["run1_1748_dockedBothTanksFlagged", true, false],
    ["run2_1752_afterRefill", false, false],
    ["run2_1820_cleanEmptyOnly", false, false],
  ])("%s: dirty full=%s, fluid empty=%s", async (capture, dirty, fluid) => {
    const rocky = createA144Vacuum();
    await rocky.reply(capture);
    expect(rocky.sensor("dirtyWaterTankFull")).toBe(dirty);
    expect(rocky.sensor("cleaningFluidEmpty")).toBe(fluid);
  });

  test("dss 0 (S8 Pro Ultra, S8_results.txt): fluid unknown, dirty tank from dock_error_status", async () => {
    // dss 0 is "not reported" (python-roborock returns None for every dss
    // field when dss is falsy). Cleaning fluid has no other source — there is
    // no dock_error_status code for it — so the sensor must claim nothing. The
    // dirty tank still has dock_error_status, which is 0 here.
    const rocky = createA144Vacuum();
    await rocky.reply("s8ProUltra_a70_docked");
    expect(rocky.sensor("dirtyWaterTankFull")).toBe(false);
    expect(rocky.sensor("cleaningFluidEmpty")).toBeNull();
  });
});

describe("#26: the diagnostic report keeps the dock status word", () => {
  test("dss survives compaction of a real 66-key get_status reply", () => {
    // n0rt0nthec4t's report (a104, 4 Oct) ends `__truncatedKeys: 23` and has
    // no dss, so the one field that says what the dock thinks of its clean
    // tank was cut away. DIAGNOSTIC_PRIORITY_KEYS (roborockAPI.js:336) keeps
    // water_shortage_status and dock_error_status but not dss. FAILS on 3.34.0.
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { Roborock } = require("../roborockLib/roborockAPI");
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "diag-dss-")),
    });

    const status = CAPTURES.run1_1713_startupAllOk.reply[0];
    expect(Object.keys(status).length).toBeGreaterThan(30);
    const compacted = api.compactDiagnosticPayload(status);

    expect(compacted.water_shortage_status).toBe(0);
    expect(compacted.dss).toBe(2216);
  });
});

describe("a dock without tanks has no tank fields", () => {
  test("an auto-empty-only dock (dock_type 5) is never read as an empty tank from dss", async () => {
    // The a144's real empty-tank reply, with its dock_type swapped for the
    // S8+'s auto-empty dock (5, S8_results.txt). python-roborock does not
    // read the tank fields for such a dock, and neither may this plugin: a
    // 1 there would be a permanent "empty" for a tank that does not exist.
    const rocky = createA144Vacuum();
    const reply = JSON.parse(
      JSON.stringify(CAPTURES.run2_1820_cleanEmptyOnly.reply)
    );
    reply[0].dock_type = 5;
    reply[0].dock_error_status = 0;
    await rocky.push(reply);
    expect(rocky.sensor("waterTankEmpty")).toBe(false);
    expect(rocky.sensor("cleaningFluidEmpty")).toBeNull();
  });
});
