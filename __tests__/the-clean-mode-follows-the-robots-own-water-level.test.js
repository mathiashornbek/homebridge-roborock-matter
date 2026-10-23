"use strict";

/**
 * The clean mode Apple Home shows during a run is derived from the robot's
 * water level: `water_box_mode` 200 is "water off", i.e. a vacuum-only run.
 *
 * The robot reports that level in every `get_status` reply and pushes it alone
 * as dps 124 when it is changed in the Roborock app. The accessory remembered
 * neither, so the level came from the cloud's HomeData snapshot — refreshed
 * every 180 seconds — and a run the robot itself reported as vacuum-only was
 * shown as Vacuum + Mop until the snapshot caught up. #8's timeline (applied
 * 16:09:20, wrong mode 16:09:29, right again 16:11:23) is that cadence.
 *
 * Real Roborock API, cloud-shaped HomeData, replies delivered as the
 * connectors deliver them.
 */

const {
  createRealApiVacuum,
} = require("../test-support/real-api-matter-vacuum");

const CLEANING = {
  state: 5,
  battery: 80,
  charge_status: 0,
  error_code: 0,
  in_cleaning: 1,
  fan_power: 102,
  mop_mode: 300,
  clean_area: 1250000,
  clean_time: 120,
};

const VACUUM = 0;
const VACUUM_AND_MOP = 2;

async function robotWithHomeDataWater(waterBoxMode) {
  return createRealApiVacuum({
    homeData: {
      error_code: 0,
      state: 8,
      battery: 100,
      fan_power: 102,
      water_box_mode: waterBoxMode,
      charge_status: 1,
    },
    platformConfig: { enableFanPowerCleanModes: false },
  });
}

const cleanMode = (robot) => robot.store.read("rvcCleanMode", "currentMode");

describe("the clean mode follows the water level the robot reports", () => {
  test("a run the robot reports with water off is a vacuum run, whatever HomeData still says", async () => {
    const robot = await robotWithHomeDataWater(201);

    await robot.localReply({ ...CLEANING, water_box_mode: 200 });

    expect(cleanMode(robot)).toBe(VACUUM);
  });

  test("a run the robot reports with water on is a vacuum + mop run, whatever HomeData still says", async () => {
    const robot = await robotWithHomeDataWater(200);

    await robot.localReply({ ...CLEANING, water_box_mode: 202 });

    expect(cleanMode(robot)).toBe(VACUUM_AND_MOP);
  });

  test("turning the water off in the Roborock app mid-run (dps 124 alone) reaches Apple Home", async () => {
    const robot = await robotWithHomeDataWater(201);
    await robot.localReply({ ...CLEANING, water_box_mode: 202 });
    expect(cleanMode(robot)).toBe(VACUUM_AND_MOP);

    await robot.api.deviceNotify("CloudMessage", {
      duid: robot.duid,
      payload: { t: 1791500774, dps: { 124: 200 } },
    });

    expect(cleanMode(robot)).toBe(VACUUM);
  });
});
