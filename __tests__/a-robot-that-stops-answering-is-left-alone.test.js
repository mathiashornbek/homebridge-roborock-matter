"use strict";

/**
 * A request that draws no answer costs a full 10-second pending request, and
 * until 3.30.0 nothing noticed that the same request had failed the same way
 * a hundred times before.
 *
 * Measured, all on robots that were otherwise working perfectly:
 *
 * - `Stueetage` (`a70`) on the maintainer's own server: `get_map_v1` had
 *   failed 95 times in a row on 17 Sep 2026, and 225 twelve days earlier.
 * - #9 (`a75`): 40 in a row, while the robot answered everything else.
 * - #22 (`a144`) and #24 (`a51`): 647 suppressed timeout warnings in one
 *   session across seven different methods.
 *
 * These tests pin the rule that stops it, and — just as important — the three
 * things it must never do: trip on a refusal, trip on a network failure, or
 * go anywhere near `get_status` and the command path.
 */

const {
  UnansweredMethodBreaker,
  isUnansweredRequest,
  OPEN_AFTER_CONSECUTIVE_TIMEOUTS,
} = require("../roborockLib/lib/unansweredMethodBreaker");

const TIMEOUT = () =>
  new Error(
    "Cloud request with id 4263 with method get_map_v1 timed out after 10 seconds. MQTT connection state: true"
  );

function makeClock(start = 1_000_000) {
  const clock = { now: start };
  const breaker = new UnansweredMethodBreaker({ now: () => clock.now });

  // From 3.32.0 the register is fed by the message layer, which sees EVERY
  // request — including `get_status` and every command. So a (robot, method)
  // pair is only counted once a caller that is entitled to skip it has said
  // so. `recordFailure` on an unclaimed pair is a no-op by design; these
  // tests stand in for `pollParameter`, which claims before it sends.
  const recordFailure = breaker.recordFailure.bind(breaker);
  breaker.recordFailure = (duid, method, error) => {
    breaker.govern(duid, method);
    return recordFailure(duid, method, error);
  };

  return { clock, breaker };
}

describe("what counts as no answer", () => {
  test("a timeout counts", () => {
    expect(isUnansweredRequest(TIMEOUT())).toBe(true);
    expect(
      isUnansweredRequest(
        new Error(
          "Local request with id 7 with method get_prop timed out after 10 seconds"
        )
      )
    ).toBe(true);
  });

  test("a refusal does not — the robot answered, it just said no", () => {
    expect(
      isUnansweredRequest(
        new Error(
          "The robot refused get_server_timer (cloud id 5): Not FCC robot (code -10007)"
        )
      )
    ).toBe(false);
  });

  test("a network failure does not — that is the link, and it comes back on its own", () => {
    for (const message of [
      "Cloud request with id 9 with method get_status timed out after 10 seconds: getaddrinfo EAI_AGAIN api-eu.roborock.com",
      "Request timed out after 10 seconds — MQTT connection state: offline",
      "connect ECONNREFUSED 192.168.1.20:58867",
    ]) {
      expect(isUnansweredRequest(new Error(message))).toBe(false);
    }
  });

  test("anything unrecognised does not", () => {
    expect(isUnansweredRequest(undefined)).toBe(false);
    expect(isUnansweredRequest(new Error("boom"))).toBe(false);
    expect(isUnansweredRequest("timed out after 10 seconds")).toBe(true);
  });
});

describe("the rule itself", () => {
  test("the first failures change nothing — a busy robot loses nothing", () => {
    const { breaker } = makeClock();
    for (let i = 1; i < OPEN_AFTER_CONSECUTIVE_TIMEOUTS; i += 1) {
      const outcome = breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
      expect(outcome.counted).toBe(true);
      expect(outcome.opened).toBe(false);
      expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(false);
    }
  });

  test("the conclusive failure opens it once, and only once", () => {
    const { breaker } = makeClock();
    let opens = 0;
    for (let i = 0; i < 40; i += 1) {
      if (breaker.recordFailure("duid", "get_map_v1", TIMEOUT()).opened) {
        opens += 1;
      }
    }
    expect(opens).toBe(1);
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(true);
  });

  test("one answer resets it completely", () => {
    const { breaker } = makeClock();
    for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_TIMEOUTS; i += 1) {
      breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    }
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(true);

    expect(breaker.recordAnswer("duid", "get_map_v1")).toBe(true);
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(false);

    // And the count really is back to zero, not merely unblocked.
    expect(breaker.recordFailure("duid", "get_map_v1", TIMEOUT()).opened).toBe(
      false
    );
  });

  test("an answer after a few failures is not reported as a recovery", () => {
    const { breaker } = makeClock();
    breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    expect(breaker.recordAnswer("duid", "get_map_v1")).toBe(false);
    expect(breaker.recordAnswer("duid", "get_map_v1")).toBe(false);
  });

  test("it retries by itself after the cooldown, and one request is all a still-silent robot costs", () => {
    const { clock, breaker } = makeClock();
    for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_TIMEOUTS; i += 1) {
      breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    }
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(true);

    clock.now += 6 * 60 * 60 * 1000;
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(false);

    // Still silent: the very next failure closes it again without needing
    // another six, because the count was kept.
    const again = breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    expect(again.opened).toBe(false);
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(true);
  });

  test("a network failure while it is open does not extend the cooldown", () => {
    const { clock, breaker } = makeClock();
    for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_TIMEOUTS; i += 1) {
      breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    }
    clock.now += 6 * 60 * 60 * 1000;
    breaker.shouldSkip("duid", "get_map_v1");
    const network = breaker.recordFailure(
      "duid",
      "get_map_v1",
      new Error("getaddrinfo EAI_AGAIN api-eu.roborock.com")
    );
    expect(network.counted).toBe(false);
    expect(breaker.shouldSkip("duid", "get_map_v1")).toBe(false);
  });

  test("robots and methods are counted apart", () => {
    const { breaker } = makeClock();
    for (let i = 0; i < 20; i += 1) {
      breaker.recordFailure("rocky", "get_map_v1", TIMEOUT());
    }
    expect(breaker.shouldSkip("rocky", "get_map_v1")).toBe(true);
    expect(breaker.shouldSkip("rocky", "get_consumable")).toBe(false);
    expect(breaker.shouldSkip("vicky", "get_map_v1")).toBe(false);

    breaker.forgetDevice("rocky");
    expect(breaker.shouldSkip("rocky", "get_map_v1")).toBe(false);
  });

  test("the open ones are reportable, for the diagnostics people paste", () => {
    const { breaker } = makeClock();
    for (let i = 0; i < 9; i += 1) {
      breaker.recordFailure("rocky", "get_map_v1", TIMEOUT());
    }
    breaker.recordFailure("rocky", "get_consumable", TIMEOUT());

    expect(breaker.describeOpen()).toEqual([
      {
        duid: "rocky",
        method: "get_map_v1",
        failures: 9,
        retryInMs: 6 * 60 * 60 * 1000,
      },
    ]);
  });
});

describe("the arithmetic that makes it worth doing", () => {
  test("a permanently silent robot costs 9 requests a day instead of 8,640", () => {
    const { clock, breaker } = makeClock();
    const DAY = 24 * 60 * 60 * 1000;
    const EVERY_10_S = 10 * 1000;
    const COOLDOWN = 6 * 60 * 60 * 1000;
    let sent = 0;

    for (let elapsed = 0; elapsed < DAY; elapsed += EVERY_10_S) {
      clock.now += EVERY_10_S;
      if (breaker.shouldSkip("duid", "get_map_v1")) {
        continue;
      }
      sent += 1;
      breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    }

    // What the rule guarantees, spelled out rather than asserted as a magic
    // number: six requests ten seconds apart to establish that the robot has
    // stopped answering, and after that one request per cooldown that fits in
    // whatever is left of the day.
    const establishing = OPEN_AFTER_CONSECUTIVE_TIMEOUTS;
    const spentEstablishing = establishing * EVERY_10_S;
    const retries = Math.floor((DAY - spentEstablishing) / COOLDOWN);

    expect(retries).toBe(3);
    expect(sent).toBe(establishing + retries);
    expect(sent).toBe(9);
    // Well under one an hour, which is the point.
    expect(sent).toBeLessThan(15);
    // What it was before: one every ten seconds, all day.
    expect(DAY / EVERY_10_S).toBe(8640);
  });

  test("the second day is cheaper still, because the six are already spent", () => {
    const { clock, breaker } = makeClock();
    const DAY = 24 * 60 * 60 * 1000;
    const EVERY_10_S = 10 * 1000;
    let sent = 0;

    for (let elapsed = 0; elapsed < 2 * DAY; elapsed += EVERY_10_S) {
      clock.now += EVERY_10_S;
      if (breaker.shouldSkip("duid", "get_map_v1")) {
        continue;
      }
      sent += 1;
      breaker.recordFailure("duid", "get_map_v1", TIMEOUT());
    }

    // Six to establish plus seven cooldowns over two days: the marginal cost
    // of a robot that never answers again settles at four requests a day.
    expect(sent).toBe(OPEN_AFTER_CONSECUTIVE_TIMEOUTS + 7);
  });
});
