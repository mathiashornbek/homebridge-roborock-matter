"use strict";

/**
 * A B01 state value the dialect tables cannot translate is unknown, never a
 * classic (v1) state number.
 *
 * `getVacuumDeviceStatus` translated a B01 robot's home-data state through
 * its family's table and, when the table had no entry, fell through to the raw
 * number. The Matter side reads that number as a v1 state. The maintainer's
 * sc05 logged "1. Sal reports error_code 501 while its state is 26"
 * (pi-roborock.log, 21 Oct 2026): no Q7 table produces 26, so a raw value
 * reached the accessory as v1 26, "going to wash the mop".
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const {
  createB01Robots,
  Q7_MODEL,
  Q10_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

async function robotWithHomeDataState(model, rawState) {
  const robots = await createB01Robots({
    robots: [
      { duid: "robot", model, deviceStatus: { 121: rawState, 122: 61 } },
    ],
  });
  return robots.api;
}

describe("a home-data state the B01 tables lack", () => {
  test("a Q7 value outside WorkStatusMapping reads as unknown", async () => {
    const api = await robotWithHomeDataState(Q7_MODEL, 26);
    expect(api.getVacuumDeviceStatus("robot", "state")).toBe("");
    // Only the state is withheld; other fields are not translated at all.
    expect(api.getVacuumDeviceStatus("robot", "battery")).toBe(61);
  });

  test("a Q10 value outside YXDeviceState reads as unknown", async () => {
    const api = await robotWithHomeDataState(Q10_MODEL, 42);
    expect(api.getVacuumDeviceStatus("robot", "state")).toBe("");
  });

  test("known values still translate, per family", async () => {
    // Q7 4 charging -> v1 8; Q10 8 charging is already v1 8.
    expect(
      (await robotWithHomeDataState(Q7_MODEL, 4)).getVacuumDeviceStatus(
        "robot",
        "state"
      )
    ).toBe(8);
    expect(
      (await robotWithHomeDataState(Q10_MODEL, 102)).getVacuumDeviceStatus(
        "robot",
        "state"
      )
    ).toBe(5);
  });
});
