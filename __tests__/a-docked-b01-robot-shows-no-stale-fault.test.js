"use strict";

/**
 * A B01 robot's `fault` field lingers after the event that set it (python
 * documents 2103 persisting while docked-idle; the maintainer's Q7s sat at
 * 100 % in the dock carrying 2105). Home Assistant reads a Q7's state from
 * its work status alone — CHARGING, MOP_AIRDRYING and the dock chores are
 * DOCKED, and no Q7 status is ERROR (homeassistant/components/roborock
 * vacuum.py Q7_STATE_CODE_TO_STATE); it has no Q7 fault entity at all — so
 * a robot in its dock is docked, whatever the field still says. In Matter a
 * fault IS the Error state, so a stale code at the dock read "Stuck" on the
 * tile, with a notification, until something overwrote the field: a Q7
 * lifted mid-run and carried home by hand did exactly that.
 *
 * Driven end to end: the Q7's answers are framed with the plugin's own B01
 * cipher and correlated by the real MQTT handler; the Matter writes land in
 * the faithful @matter/node 0.17.9 store model.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const {
  createB01Robots,
  Q7_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");
const { createMatterStore } = require("../test-support/matter-0.17.9-store");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const DUID = "duid-garage";
const NO_ERROR = 0;
const STUCK = 65;
const CHARGING = 65;
const ERROR_STATE = 3;

async function q7WithTile() {
  const robots = await createB01Robots({
    robots: [{ duid: DUID, name: "Garage", model: Q7_MODEL }],
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
    getMatterApi: () => store,
    shouldAcceptUnscopedLiveMessage: () => false,
    roborockAPI: robots.api,
  };
  const accessory = { UUID: "uuid-garage", context: { duid: DUID } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: DUID },
    true
  );
  store = createMatterStore(accessory.clusters);
  const deliveries = [];
  robots.api.setDeviceNotify((id, message) => {
    deliveries.push(vacuum.notifyDeviceUpdater(id, message));
  });

  async function robotReports(answer) {
    const result = robots.api.refreshB01Status(DUID, { force: true });
    await robots.waitForSent(DUID, robots.sentTo(DUID).length + 1);
    await robots.q7Answers(DUID, answer);
    await result;
    await Promise.all(deliveries);
    robots.api._b01StatusState.get(DUID).lastAttemptAt = 0;
  }

  return { robots, vacuum, store, robotReports };
}

const fault = (harness) =>
  harness.store.read("rvcOperationalState", "operationalError")?.errorStateId ??
  NO_ERROR;

describe("a B01 robot in its dock shows no stale fault", () => {
  let harness;
  afterEach(() => {
    harness?.vacuum.dispose();
    harness?.robots.api.clearTimersAndIntervals();
  });

  test("a Q7 trapped mid-run and docked by hand reads Charging, not Stuck", async () => {
    harness = await q7WithTile();
    // Cleaning, then trapped: a Q7 has no error status, it pauses.
    await harness.robotReports({ status: 5, quantity: 70, fault: 0, mode: 0 });
    await harness.robotReports({
      status: 2,
      quantity: 69,
      fault: 513,
      mode: 0,
    });
    expect(fault(harness)).toBe(NO_ERROR);
    // Carried to the dock; the field still holds 513.
    await harness.robotReports({
      status: 4,
      quantity: 69,
      fault: 513,
      mode: 0,
    });
    expect(fault(harness)).toBe(NO_ERROR);
    expect(harness.store.read("rvcOperationalState", "operationalState")).toBe(
      CHARGING
    );
  });

  test("a fault raised at rest off the dock is cleared once the robot is docked", async () => {
    harness = await q7WithTile();
    await harness.robotReports({
      status: 1,
      quantity: 70,
      fault: 510,
      mode: 0,
    });
    expect(fault(harness)).toBe(STUCK);
    expect(harness.store.read("rvcOperationalState", "operationalState")).toBe(
      ERROR_STATE
    );
    await harness.robotReports({
      status: 4,
      quantity: 70,
      fault: 510,
      mode: 0,
    });
    expect(fault(harness)).toBe(NO_ERROR);
    expect(harness.store.read("rvcOperationalState", "operationalState")).toBe(
      CHARGING
    );
  });

  test("a Q7 drying its mop in the dock shows no fault either", async () => {
    harness = await q7WithTile();
    await harness.robotReports({
      status: 10,
      quantity: 99,
      fault: 511,
      mode: 0,
    });
    expect(fault(harness)).toBe(NO_ERROR);
  });
});
