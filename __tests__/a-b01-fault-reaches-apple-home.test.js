"use strict";

/**
 * A B01 robot's real faults reach Apple Home through the same fault path a
 * classic robot's do.
 *
 * Until now every non-zero B01 `error_code` was "unmapped": the accessory
 * decided a robot spoke v1 when it reported no `matter_clean_type`, and a Q7
 * always reports one, so a trapped Q7 (B01Fault 513) or one with no dustbin
 * (503) published no fault at all. The faults are now classified in the
 * protocol library from python-roborock's own descriptions, per family, and
 * the accessory asks which dialect the robot speaks instead of guessing it.
 *
 * Driven end to end: the Q7's answer is framed with the plugin's own B01
 * cipher and correlated by the real MQTT handler, and the Matter writes land
 * in the faithful @matter/node 0.17.9 store model.
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
const STUCK = 65;
const DUST_BIN_MISSING = 66;

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
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
    }),
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

  return { robots, vacuum, store, platform, robotReports };
}

describe("a Q7 fault reaches the tile", () => {
  let harness;

  afterEach(() => {
    harness?.vacuum.dispose();
    harness?.robots.api.clearTimersAndIntervals();
  });

  test("a trapped Q7 at rest publishes Stuck", async () => {
    harness = await q7WithTile();
    // 1 waiting_for_orders: at rest, so the fault gate lets a fault through.
    await harness.robotReports({
      status: 1,
      quantity: 80,
      fault: 513,
      mode: 0,
      wind: 2,
    });
    expect(
      harness.store.read("rvcOperationalState", "operationalError")
    ).toEqual({ errorStateId: STUCK });
  });

  test("a Q7 at rest reporting no dust bag publishes DustBinMissing", async () => {
    // At rest off the dock: in its dock a B01 robot is docked whatever its
    // fault field says (a-docked-b01-robot-shows-no-stale-fault.test.js).
    harness = await q7WithTile();
    await harness.robotReports({
      status: 1,
      quantity: 60,
      fault: 594,
      mode: 0,
      wind: 2,
    });
    expect(
      harness.store.read("rvcOperationalState", "operationalError")
    ).toEqual({ errorStateId: DUST_BIN_MISSING });
  });

  test("a Q7 answer without `mode` is still not read in v1 numbering", async () => {
    // v1 9 is "Dust bin missing"; B01 has no fault 9. Before, a Q7 answer that
    // omitted `mode` made the accessory treat the robot as v1.
    harness = await q7WithTile();
    await harness.robotReports({ status: 1, quantity: 80, fault: 9, wind: 2 });
    const error = harness.store.read("rvcOperationalState", "operationalError");
    expect(error?.errorStateId ?? 0).toBe(0);
    expect(
      harness.platform.log.info.mock.calls.some(([line]) =>
        /reports error_code 9 /.test(line)
      )
    ).toBe(true);
  });

  test("the numbers the two B01 families disagree on publish nothing on a Q7", async () => {
    // Upstream: 500, 501, 503, 569 and 570 mean different things on Q7 and
    // Q10, and the sc05 has been seen using 501 with the Q10's meaning.
    harness = await q7WithTile();
    await harness.robotReports({
      status: 1,
      quantity: 60,
      fault: 503,
      mode: 0,
      wind: 2,
    });
    const error = harness.store.read("rvcOperationalState", "operationalError");
    expect(error?.errorStateId ?? 0).toBe(0);
  });

  test("501 at the end of a run stays out of the fault table", async () => {
    // Upstream labels Q7 501 robot_suspended, but the maintainer's sc05
    // emitted it at the end of a normal run, just before docking
    // (pi-roborock.log 21 Oct 2026). Named once in the log, never published.
    harness = await q7WithTile();
    await harness.robotReports({
      status: 1,
      quantity: 80,
      fault: 501,
      mode: 0,
      wind: 2,
    });
    const error = harness.store.read("rvcOperationalState", "operationalError");
    expect(error?.errorStateId ?? 0).toBe(0);
  });
});

describe("each family's faults are read in its own numbering", () => {
  test("a Q10's fault codes go through the Q10 table, not the Q7 one", async () => {
    const { Q10_MODEL } = require("../test-support/b01-robot-on-a-fake-broker");
    const robots = await createB01Robots({
      robots: [
        { duid: "q10", model: Q10_MODEL },
        { duid: "q7", model: Q7_MODEL },
      ],
    });
    // YXFault 8 robot_trapped; B01Fault has no 8.
    expect(robots.api.describeB01Fault("q10", 8)?.id).toBe(STUCK);
    expect(robots.api.describeB01Fault("q7", 8)).toBeNull();
    // 503 is docking_error on a Q10 and one of the numbers the families
    // disagree on, so it publishes nothing on a Q7.
    expect(robots.api.describeB01Fault("q10", 503)?.id).toBe(64);
    expect(robots.api.describeB01Fault("q7", 503)).toBeNull();
    // A trapped Q7 is 513.
    expect(robots.api.describeB01Fault("q7", 513)?.id).toBe(STUCK);
  });
});
