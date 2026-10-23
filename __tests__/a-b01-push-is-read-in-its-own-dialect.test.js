"use strict";

/**
 * A datapoint a B01 robot pushes is read in that robot's own dialect, at the
 * transport boundary, before anything reaches the Matter side.
 *
 * Pushed datapoints used to go to the accessory raw, where they were read as
 * classic (v1) datapoints: only the state (121) was patched for a Q10. So a
 * Q10's suction (123, YXFanLevel 0-4 and 8) landed as v1 fan power 4 and the
 * Apple Home selection snapped back, its clean mode (137) and fault (90, nested
 * under dpCommon 101) were never read, and a Q7's raw 121 was read as a v1
 * state ("state 26" in the field). python-roborock flattens dpCommon and reads
 * each datapoint through the Q10 enums (b01_q10_protocol.decode_rpc_response,
 * testing/b01_q10_simulator.py).
 *
 * Driven through the real MQTT handler with frames built by the plugin's own
 * (symmetric) B01 cipher.
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
const { createMatterStore } = require("../test-support/matter-0.17.9-store");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const Q10 = "duid-q10";
const Q7 = "duid-q7";

async function robotsWithInbox() {
  const robots = await createB01Robots({
    robots: [
      { duid: Q10, name: "Kitchen Q10", model: Q10_MODEL },
      { duid: Q7, name: "1. Sal", model: Q7_MODEL },
    ],
  });
  const inbox = [];
  robots.api.setDeviceNotify((id, message) => inbox.push({ id, message }));
  return { ...robots, inbox };
}

describe("a Q10 push is read in Q10 units", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  test("suction, clean mode and a fault nested under dpCommon arrive as v1 fields", async () => {
    robots = await robotsWithInbox();
    await robots.pushes(Q10, { 123: 8, 137: 2, 101: { 90: 8 } });

    expect(robots.inbox).toEqual([
      {
        id: "CloudMessage",
        message: {
          duid: Q10,
          payload: [{ fan_power: 108, matter_clean_type: 0, error_code: 8 }],
        },
      },
    ]);
  });

  test("every suction level, including off, is translated", async () => {
    robots = await robotsWithInbox();
    for (const wind of [0, 1, 2, 3, 4, 8]) {
      await robots.pushes(Q10, { 123: wind });
    }
    expect(
      robots.inbox.map(({ message }) => message.payload[0].fan_power)
    ).toEqual([105, 101, 102, 103, 104, 108]);
  });

  test("the state is translated, an unknown one is withheld, and charging is derived", async () => {
    robots = await robotsWithInbox();
    await robots.pushes(Q10, { 121: 102, 122: 77 });
    await robots.pushes(Q10, { 121: 8 });
    await robots.pushes(Q10, { 121: 42 });
    expect(robots.inbox.map(({ message }) => message.payload[0])).toEqual([
      { state: 5, charge_status: 0, battery: 77 },
      { state: 8, charge_status: 1 },
    ]);
  });

  test("lifecycle fault codes are not faults, and the water level is not guessed", async () => {
    robots = await robotsWithInbox();
    // 501: "cleaning completed, returning" (hw-confirmed, fires per task).
    await robots.pushes(Q10, { 101: { 90: 501 }, 124: 2 });
    expect(robots.inbox.map(({ message }) => message.payload[0])).toEqual([
      { error_code: 0 },
    ]);
  });

  test("a trapped Q10 shows Stuck on its tile", async () => {
    robots = await createB01Robots({
      robots: [{ duid: Q10, name: "Kitchen Q10", model: Q10_MODEL }],
    });
    let store;
    const platform = {
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      platformConfig: { enableMatter: true },
      getMatterApi: () => ({
        updateAccessoryState: (...args) => store.updateAccessoryState(...args),
      }),
      shouldAcceptUnscopedLiveMessage: () => false,
      roborockAPI: robots.api,
    };
    const accessory = { UUID: "uuid-q10", context: { duid: Q10 } };
    const vacuum = new RoborockMatterVacuumAccessory(
      platform,
      accessory,
      { duid: Q10 },
      true
    );
    store = createMatterStore(accessory.clusters);
    const deliveries = [];
    robots.api.setDeviceNotify((id, message) =>
      deliveries.push(vacuum.notifyDeviceUpdater(id, message))
    );

    // 12 is the Q10's error state; YXFault 8 is robot_trapped.
    await robots.pushes(Q10, { 121: 12, 122: 64, 101: { 90: 8 } });
    await Promise.all(deliveries);
    vacuum.dispose();

    expect(store.read("rvcOperationalState", "operationalError")).toEqual({
      errorStateId: 65,
    });
  });
});

describe("a Q7 push is never read as a classic datapoint", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  test("its raw state is not delivered; a status read is taken instead", async () => {
    robots = await robotsWithInbox();
    await robots.pushes(Q7, { 121: 26, 120: 501 });

    expect(robots.inbox.filter(({ message }) => message.duid === Q7)).toEqual(
      []
    );
    const sent = await robots.waitForSent(Q7);
    expect(sent[0].dps["10000"].method).toBe("prop.get");
  });

  test("the datapoints it pushed are named once per robot", async () => {
    robots = await robotsWithInbox();
    await robots.pushes(Q7, { 121: 26 });
    await robots.pushes(Q7, { 121: 5 });

    const lines = robots.log.info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("pushed datapoint"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/1\. Sal/);
    expect(lines[0]).toContain('"121":26');
  });
});
