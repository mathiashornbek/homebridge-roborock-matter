"use strict";

// A Routine's schedule switch reads the scene's triggers to show its state
// and rewrites them to change it. The two picked triggers differently:
// reading took any trigger carrying a cron, writing only the TIMER triggers.
// A scene with another trigger carrying a cron would then show "on" from that
// trigger, and switching it off — which flips only the TIMER — could never be
// confirmed, so the switch kept snapping back. Both now ask one question:
// is this a TIMER trigger with a cron.

const {
  parseCloudSceneSchedules,
  buildSceneParamWithTimersEnabled,
  cloudSceneScheduleIsActive,
} = require("../roborockLib/lib/parseCloudSceneSchedules");
const { scene, trigger } = require("../test-support/schedule-account");

const DUID = "duid-a144";

/** A trigger of another kind that happens to carry a cron. */
function otherTriggerWithCron(enabled) {
  return {
    ...trigger(enabled, "30 7 * * *"),
    id: 99,
    name: "CONDITION",
    type: "CONDITION",
  };
}

function withTriggers(...triggers) {
  const base = scene({ id: 5, name: "Mornings", duid: DUID });
  const param = JSON.parse(base.param);
  param.triggers = triggers;
  return { ...base, param: JSON.stringify(param) };
}

test("the switch position comes from the TIMER triggers it can write", () => {
  const routine = withTriggers(trigger(false), otherTriggerWithCron(true));

  expect(cloudSceneScheduleIsActive(routine)).toBe(false);
  const built = buildSceneParamWithTimersEnabled(routine, true);
  const after = { ...routine, param: JSON.stringify(built) };
  // Switching it on is then confirmable by reading it back.
  expect(cloudSceneScheduleIsActive(after)).toBe(true);
});

test("a scene whose only cron is on another kind of trigger is not offered as a schedule", () => {
  const routine = withTriggers(otherTriggerWithCron(true));

  expect(parseCloudSceneSchedules([routine])).toEqual([]);
  expect(buildSceneParamWithTimersEnabled(routine, false)).toBeNull();
});
