"use strict";

/**
 * Resume on a paused Q10 room or zone clean continues it, instead of starting
 * a fresh whole-home clean.
 *
 * Every B01 robot was told `supportsSegmentResume() === false`, so Matter's
 * Resume sent `app_start`, which the Q10 dialect writes as dpStartClean
 * `{"201":1}`: a new whole-home run (the #28 class, on a Q10). The Q10 has a
 * resume datapoint, dpResume `{"205":0}`, "Verified live" in python-roborock
 * (`q10/vacuum.py resume_clean`), and it reports which task is running in
 * dpCleanTaskType (138), which is what the accessory needs to choose the verb.
 * A paused whole-home clean keeps `app_start`, as Home Assistant sends for a
 * Q10. The Q7 has no known resume value and keeps its behaviour.
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
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const Q10 = "duid-q10";
const Q7 = "duid-q7";

async function robots() {
  return createB01Robots({
    robots: [
      { duid: Q10, name: "Kitchen Q10", model: Q10_MODEL },
      { duid: Q7, name: "Garage", model: Q7_MODEL },
    ],
  });
}

function accessoryFor(api, duid) {
  const platform = {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    platformConfig: { enableMatter: true },
    getMatterApi: () => null,
    shouldAcceptUnscopedLiveMessage: () => false,
    roborockAPI: api,
  };
  return new RoborockMatterVacuumAccessory(
    platform,
    { UUID: `uuid-${duid}`, context: { duid } },
    { duid },
    false
  );
}

describe("a paused Q10 clean is continued", () => {
  let harness;
  afterEach(() => harness?.api.clearTimersAndIntervals());

  test("both resume verbs are written as dpResume", async () => {
    harness = await robots();
    for (const verb of ["resume_segment_clean", "resume_zoned_clean"]) {
      await harness.api.messageQueueHandler.sendRequest(Q10, verb, []);
    }
    expect(harness.sentTo(Q10)).toEqual([
      { dps: { 205: 0 } },
      { dps: { 205: 0 } },
    ]);
  });

  test("the task the Q10 pushed decides the verb the tile sends", async () => {
    harness = await robots();
    const vacuum = accessoryFor(harness.api, Q10);

    // Paused (10) in a room clean (dpCleanTaskType 2, "electoral").
    await harness.pushes(Q10, { 121: 10, 138: 2 });
    expect(vacuum["getResumeVerb"]()).toBe("resume_segment_clean");

    // Paused in a zone clean (3, "divideareas").
    await harness.pushes(Q10, { 138: 3 });
    expect(vacuum["getResumeVerb"]()).toBe("resume_zoned_clean");

    // Paused in a whole-home clean (1, "smart"): app_start, as HA sends.
    await harness.pushes(Q10, { 138: 1 });
    expect(vacuum["getResumeVerb"]()).toBe("app_start");
    vacuum.dispose();
  });

  test("a Q7 keeps app_start: it has no known resume value", async () => {
    harness = await robots();
    expect(harness.api.supportsSegmentResume(Q7)).toBe(false);
    expect(harness.api.supportsSegmentResume(Q10)).toBe(true);
  });
});
