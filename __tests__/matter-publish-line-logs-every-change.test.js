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
  return { instance, info, debug: platform.log.debug, updateAccessoryState };
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
  operationalError,
} = {}) {
  return {
    rvcRunMode: { currentMode: runMode },
    rvcOperationalState:
      operationalError === undefined
        ? { operationalState }
        : { operationalState, operationalError },
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

  test("a snapshot with no fault says nothing about faults", async () => {
    // The history here is worth keeping, because this test has now been on
    // both sides of the same question. It originally hand-built an
    // operationalError and asserted `fault=4 (stuck)`; 3.4.1 withdrew fault
    // publishing, that cluster shape became unreachable, and the assertion was
    // keeping a dead branch alive. It was rewritten to assert the line never
    // mentions faults at all — which is now equally wrong, because 3.12.0
    // publishes WaterTankEmpty again.
    //
    // So the rule is neither "always" nor "never": the field appears when the
    // cluster carries a real fault and stays away when it does not. Both
    // halves are asserted, here and in the test below, so the line can never
    // again describe an attribute that is not there.
    const { instance, info } = createHarness();
    await publish(instance, snapshot({ operationalState: 3 }));

    const lines = publishLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("fault");
  });

  test("a snapshot carrying a fault names it", async () => {
    const { instance, info } = createHarness();
    await publish(
      instance,
      snapshot({ operationalState: 0, operationalError: { errorStateId: 68 } })
    );

    const lines = publishLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fault=68 (Clean water tank empty)");
  });

  test("a cleared fault is not rendered as one", async () => {
    // NoError is published on every healthy update, so if the line rendered
    // `fault=0` it would say something is wrong on every robot, forever.
    const { instance, info } = createHarness();
    await publish(
      instance,
      snapshot({ operationalState: 0, operationalError: { errorStateId: 0 } })
    );

    const lines = publishLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("fault");
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

// Silence at INFO is the point of the deduplication above. Silence at EVERY
// level is a different thing, and it cost issue #7 a round trip.
//
// jawnlydon was asked to check whether these lines were still being written
// while his Apple Home tile was dead — the cheap way to tell "the plugin
// stopped" from "the Matter session died underneath a healthy plugin". His
// sc05 was docked at 100 %, so the rendered line was identical every minute:
//
//   06:12:14  Matter publish for Robo: battery=100%, operationalState=0, ...
//   06:23     tile dead. Nothing logged in between.
//
// He looked, correctly found nothing in eleven minutes, and the answer was
// worthless — absence is what the method does when nothing changes, not
// evidence about whether it ran. The question was unanswerable from the log at
// any log level, which is the defect: the 60-second forced write is the
// plugin's own liveness signal and it left no trace of itself.
//
// The rule: a publish that is suppressed at info is still recorded at debug. It
// costs nothing when debug is off, and it keeps the info log exactly as quiet as
// the deduplication intends.
describe("a suppressed publish is still recorded at debug", () => {
  const debugLines = (debug) =>
    debug.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Matter publish for"));

  test("the idle heartbeat leaves a trace of itself", async () => {
    const { instance, info, debug } = createHarness();
    await publish(instance, snapshot());
    expect(publishLines(info)).toHaveLength(1);

    await instance.publishRoborockSnapshot(
      snapshot(),
      "Matter state heartbeat",
      { force: true }
    );

    // Still one info line — the deduplication is intact.
    expect(publishLines(info)).toHaveLength(1);
    // And exactly one debug line saying the write happened anyway.
    expect(debugLines(debug)).toHaveLength(1);
    expect(debugLines(debug)[0]).toContain("Matter state heartbeat");
  });

  test("the debug line names the robot and carries the full values", async () => {
    // Same requirement as every other line in this plugin: a multi-robot log
    // is unreadable without the name, and the values are the whole evidence.
    const { instance, debug } = createHarness();
    await publish(instance, snapshot({ battery: 150, operationalState: 1 }));
    await instance.publishRoborockSnapshot(
      snapshot({ battery: 150, operationalState: 1 }),
      "Matter state heartbeat",
      { force: true }
    );

    expect(debugLines(debug)[0]).toContain("Weebo");
    expect(debugLines(debug)[0]).toContain(
      "battery=75%, operationalState=1, runMode=0, cleanMode=0."
    );
  });

  test("one trace per suppressed publish, so a stopped heartbeat is visible", async () => {
    // The value is in the CADENCE: eleven minutes of a docked robot must leave
    // eleven traces, so a gap in them is the finding.
    const { instance, debug } = createHarness();
    await publish(instance, snapshot());

    for (let i = 0; i < 11; i += 1) {
      await instance.publishRoborockSnapshot(
        snapshot(),
        "Matter state heartbeat",
        { force: true }
      );
    }

    expect(debugLines(debug)).toHaveLength(11);
  });

  test("the reason is named, so the two liveness questions stay separable", async () => {
    // A heartbeat proves the Matter write path runs; a poll proves the Roborock
    // side still answers. A trace that does not say which answers neither.
    const { instance, debug } = createHarness();
    await publish(instance, snapshot());
    await publish(instance, snapshot());

    expect(debugLines(debug)).toHaveLength(1);
    expect(debugLines(debug)[0]).toContain("test");
  });

  test("a publish that WAS logged at info is not also logged at debug", async () => {
    // Otherwise every change is stated twice and the debug trace stops being a
    // record of what the info log omitted.
    const { instance, info, debug } = createHarness();
    await publish(instance, snapshot());
    await publish(instance, snapshot({ operationalState: RUNNING }));

    expect(publishLines(info)).toHaveLength(2);
    expect(debugLines(debug)).toHaveLength(0);
  });
});
