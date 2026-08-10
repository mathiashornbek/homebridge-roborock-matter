"use strict";

// The `Matter publish for <robot>: battery=…, operationalState=…, runMode=…,
// cleanMode=…` line exists for exactly one purpose, stated when runMode and
// cleanMode were added to it in 3.2.0: "making Apple Home display issues
// diagnosable from a single log excerpt". It could not do that job, because
// the line was only emitted when the BATTERY value changed.
//
// The cost showed up in issue #8. A user reported that the Apple Home tile
// sat on "Traveling to Room"/"Preparing" for a whole run, and the log he sent
// covered the entire run — but every operational-state transition in it was
// invisible, because the line only appeared on the four polls where the
// battery happened to tick down. The one question the line is for ("what did
// the plugin actually hand to Matter, and when?") was unanswerable from a log
// that contained the answer.
//
// So the rule is not "log on battery change" and it is not "log on battery,
// state, runMode or cleanMode change" either — a hand-written field list is
// the same failure mode as a hand-written line list (see
// log-lines-name-the-robot.test.js for that lesson one level up). The rule is:
//
//   if the rendered line differs from the last one logged, log it.
//
// That is enumerable by construction: any value the line names is a value
// that triggers the line, and a field added to the message tomorrow is
// covered the moment it is added. These tests assert the rule field by field
// so a future "only log on X" optimisation cannot quietly return.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RUNNING = 1;
const DOCKED = 66;

function createHarness() {
  const info = jest.fn();
  const updateAccessoryState = jest.fn().mockResolvedValue(undefined);
  const platform = {
    log: { info, warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    platformConfig: { enableMatter: true },
    getMatterApi: () => ({ updateAccessoryState }),
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Weebo" : "",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => 0,
    },
  };
  const accessory = { UUID: "uuid-publish-log", context: { duid: "duid-1" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-1" },
    false
  );
  instance.markRegistered();
  return { instance, info, updateAccessoryState };
}

// Publish an explicit cluster snapshot, bypassing the Roborock status
// plumbing: this test is about the logging decision, not about how the
// snapshot is derived.
async function publish(instance, clusters) {
  return instance.publishRoborockSnapshot(clusters, "test");
}

function snapshot({
  battery = 200,
  operationalState = DOCKED,
  runMode = 0,
  cleanMode = 0,
} = {}) {
  return {
    rvcRunMode: { currentMode: runMode },
    rvcOperationalState: { operationalState },
    rvcCleanMode: { currentMode: cleanMode },
    powerSource: { batPercentRemaining: battery },
  };
}

function publishLines(info) {
  return info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("Matter publish for"));
}

describe("the Matter publish line is emitted whenever what it says changes", () => {
  test("the first publish is logged", async () => {
    const { instance, info } = createHarness();
    await publish(instance, snapshot());
    expect(publishLines(info)).toHaveLength(1);
    expect(publishLines(info)[0]).toBe(
      "Matter publish for Weebo: battery=100%, operationalState=66, runMode=0, cleanMode=0."
    );
  });

  test("an unchanged republish is not logged again", async () => {
    const { instance, info } = createHarness();
    await publish(instance, snapshot());
    await publish(instance, snapshot());
    await publish(instance, snapshot());
    expect(publishLines(info)).toHaveLength(1);
  });

  // The rule, field by field. Each field is changed ALONE, so none of these
  // can pass by riding along on another field's change.
  const fields = [
    { name: "battery", change: { battery: 186 } },
    { name: "operationalState", change: { operationalState: RUNNING } },
    { name: "runMode", change: { runMode: 1 } },
    { name: "cleanMode", change: { cleanMode: 2 } },
  ];

  test.each(fields)(
    "a change to $name alone produces a new line",
    async ({ change }) => {
      const { instance, info } = createHarness();
      await publish(instance, snapshot());
      expect(publishLines(info)).toHaveLength(1);

      await publish(instance, snapshot(change));
      const lines = publishLines(info);
      expect(lines).toHaveLength(2);
      expect(lines[1]).not.toBe(lines[0]);
    }
  );

  test("every value the line names appears in it", async () => {
    const { instance, info } = createHarness();
    await publish(
      instance,
      snapshot({
        battery: 150,
        operationalState: RUNNING,
        runMode: 1,
        cleanMode: 2,
      })
    );
    expect(publishLines(info)[0]).toBe(
      "Matter publish for Weebo: battery=75%, operationalState=1, runMode=1, cleanMode=2."
    );
  });

  test("a published fault is part of the line and of the change decision", async () => {
    const { instance, info } = createHarness();
    const base = snapshot({ operationalState: 3 });
    await publish(instance, base);
    expect(publishLines(info)).toHaveLength(1);

    const withFault = {
      ...base,
      rvcOperationalState: {
        operationalState: 3,
        operationalError: { errorStateId: 4, errorStateDetails: "stuck" },
      },
    };
    await publish(instance, withFault);
    const lines = publishLines(info);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("fault=4 (stuck)");
  });

  test("a forced heartbeat republish of unchanged values stays silent", async () => {
    const { instance, info } = createHarness();
    await publish(instance, snapshot());
    await instance.publishRoborockSnapshot(
      snapshot(),
      "Matter state heartbeat",
      {
        force: true,
      }
    );
    expect(publishLines(info)).toHaveLength(1);
  });

  test("a fresh registration re-logs the current line", async () => {
    const { instance, info } = createHarness();
    await publish(instance, snapshot());
    expect(publishLines(info)).toHaveLength(1);

    // Re-registration means a new Matter node that has been told nothing:
    // the evidence line has to be restated for the new node.
    instance.markRegistered();
    await publish(instance, snapshot());
    expect(publishLines(info)).toHaveLength(2);
  });
});
