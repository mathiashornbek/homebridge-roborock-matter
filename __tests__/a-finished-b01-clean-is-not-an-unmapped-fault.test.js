const b01 = require("../roborockLib/lib/b01Q7Adapter");

const Q7 = b01.B01_FAMILY.Q7;
const Q10 = b01.B01_FAMILY.Q10;

/**
 * A healthy B01 robot that has just finished cleaning must not look like a
 * robot carrying a fault nobody can explain.
 *
 * WHERE THIS CAME FROM, AND IT IS A MEASUREMENT RATHER THAN A PREFERENCE. On
 * 2 Sep 2026 the maintainer's `1. Sal` (a `roborock.vacuum.sc05`, so the Q7
 * family) logged 6 distinct unmapped `error_code`s in one day — 2110, 2108,
 * 501, 2102, 2103 and the long-standing 2105 — every one of them while the
 * robot was running, and it finished its run and docked at 100 %. Nothing was
 * wrong with it at any point.
 *
 * Read against python-roborock's own per-family tables, 2 of those 6 are not
 * faults at all:
 *
 *   * Q7 `B01Fault.F_2102` = "Cleaning completed. Returning to the dock."
 *   * Q7 `B01Fault.F_2100` = "Low battery. Resume cleaning after recharging."
 *
 * The first fires after EVERY task. That is the same shape as the Q10 code
 * this adapter already zeroes — upstream marks `YXFault` 501
 * ("cleaning_completed_returning") as hw-confirmed and "fires per completed
 * task" — so the Q7 family was simply missing its own equivalent. Likewise
 * Q10's 502 ("low_battery_resume", hw-confirmed lifecycle) is already
 * informational here while the Q7 analogue 2100 was not.
 *
 * The asymmetry runs the other way too: upstream marks `YXFault` 407
 * ("cleaning_in_progress", hw-confirmed, "lifecycle, not an error") on the
 * Q10, and this adapter zeroes 407 for the Q7 but not for the Q10.
 *
 * WHY IT MATTERS EVEN THOUGH APPLE HOME IS UNAFFECTED. No B01 number appears
 * in the plugin's v1 error table (its keys are 1-24, 254 and 255), so an
 * unrecognised B01 code publishes nothing and cannot draw a fault on a healthy
 * tile — that part is the 3.13.1 lesson and it holds. What a lingering code
 * does reach is the log: `reportUnmappedErrorCode` names it once per run and
 * asks the user to report the number "if the robot really is in trouble right
 * now". Asking that after every completed clean invites exactly the false
 * model report that line exists to avoid, and this plugin already has 4 open
 * B01 model issues whose whole content is data like this.
 *
 * WHAT IS DELIBERATELY LEFT SURFACING. Only codes upstream documents as
 * lifecycle notifications of a healthy robot are silenced here. Q7's 2003
 * ("Battery level below 20%. Scheduled task canceled") and 2007/2012 ("Unable
 * to reach the target. Cleaning ended") are outcomes a user may well want to
 * know about — a scheduled clean that did not happen is not noise — so they
 * keep surfacing. And the codes upstream itself has no description for stay
 * exactly as they are: 2103, 2105, 2108 and 2110 are bare `fault_NNNN`
 * entries even upstream, so silencing them would be a guess rather than a
 * translation.
 */
describe("a finished B01 clean is not an unmapped fault", () => {
  test("Q7: the per-task completion code does not surface as an error", () => {
    // "Cleaning completed. Returning to the dock." — fires after every task.
    expect(b01.mapStatusToV1({ status: 3, fault: 2102 }, Q7).error_code).toBe(
      0
    );
  });

  test("Q7: the low-battery resume code does not surface as an error", () => {
    // "Low battery. Resume cleaning after recharging." The robot is announcing
    // normal auto-recharge-and-resume, which is what Q10's 502 already means
    // here.
    expect(b01.mapStatusToV1({ status: 3, fault: 2100 }, Q7).error_code).toBe(
      0
    );
  });

  test("Q10: the cleaning-in-progress lifecycle code does not surface either", () => {
    // Upstream: hw-confirmed on a physical ss07, "lifecycle, not an error" —
    // a due scheduled clean fired mid-clean and was ignored. Identical meaning
    // to the Q7's 407, which this adapter has always zeroed.
    expect(b01.mapStatusToV1({ status: 5, fault: 407 }, Q10).error_code).toBe(
      0
    );
  });

  test("the families stay separate — a silenced code is silenced for one family only", () => {
    // Upstream's Q10 table has no 21xx range at all, so neither of the Q7
    // codes above may be silenced for a Q10.
    expect(b01.mapStatusToV1({ status: 3, fault: 2102 }, Q10).error_code).toBe(
      2102
    );
    expect(b01.mapStatusToV1({ status: 3, fault: 2100 }, Q10).error_code).toBe(
      2100
    );
    // And the Q10-only lifecycle codes are still not silenced for a Q7, where
    // upstream gives 500/501/503 entirely different meanings.
    expect(b01.mapStatusToV1({ status: 4, fault: 501 }, Q7).error_code).toBe(
      501
    );
    expect(b01.mapStatusToV1({ status: 4, fault: 400 }, Q7).error_code).toBe(
      400
    );
  });

  test("codes upstream cannot explain keep surfacing, because silencing them would be a guess", () => {
    for (const fault of [2103, 2105, 2108, 2110]) {
      expect(b01.mapStatusToV1({ status: 5, fault }, Q7).error_code).toBe(
        fault
      );
    }
  });

  test("an outcome the user may want to know about is not silenced as noise", () => {
    // 2003: a scheduled clean that did not run. 2007/2012: a clean that ended
    // without reaching the target. Neither is a healthy robot's lifecycle.
    for (const fault of [2003, 2007, 2012]) {
      expect(b01.mapStatusToV1({ status: 3, fault }, Q7).error_code).toBe(
        fault
      );
    }
  });

  test("real Q7 faults are untouched", () => {
    // 500 lidar_blocked, 503 dustbin_not_installed, 510 bumper_stuck,
    // 513 robot_trapped, 568 main_wheels_entangled.
    for (const fault of [500, 503, 510, 513, 568]) {
      expect(b01.mapStatusToV1({ status: 5, fault }, Q7).error_code).toBe(
        fault
      );
    }
  });

  test("a genuinely healthy robot still reports no error at all", () => {
    expect(b01.mapStatusToV1({ status: 4, fault: 0 }, Q7).error_code).toBe(0);
    expect(b01.mapStatusToV1({ status: 4, fault: 0 }, Q10).error_code).toBe(0);
  });

  test("silencing a code changes nothing else about the status", () => {
    // The fault field is a separate diagnostic channel: it must not reach the
    // work status, and zeroing it must not either.
    const finished = b01.mapStatusToV1(
      { status: 3, fault: 2102, quantity: 46, wind: 2 },
      Q7
    );
    // status 3 = docking -> v1 15 (Matter: seeking charger)
    expect(finished.state).toBe(15);
    expect(finished.battery).toBe(46);
    expect(finished.charge_status).toBe(0);
    expect(finished.error_code).toBe(0);
  });
});
