"use strict";

// The give-up register's wiring (3.32.0+), driven through the REAL
// Roborock instance, its REAL messageQueueHandler timeouts and its REAL
// local reply dispatcher. Only network/cipher edges are faked (see
// test-support/real-roborock-wire.js).
//
// 1. DOUBLE COUNTING on the classic live-room fetch. messageQueueHandler's
//    timeout already calls `noteRequestUnanswered(duid, "get_map_v1", err)`
//    (counted: the pair is governed), then rejects; refreshClassicLiveRoom's
//    catch calls `noteLiveRoomFetchFailed(..., "get_map_v1")`, which calls
//    `noteMethodUnanswered` and counts the SAME timeout again. Live-room
//    tracking is paused for six hours after THREE silent fetches, not six.
//
// 2. AN ERROR REPLY IS AN ANSWER, BUT DOES NOT RESET THE COUNT. Both
//    connectors hand a refusal straight to the stored `reject`, bypassing the
//    wrapped `resolve` that is the register's only "answered" hook. So five
//    timeouts + an error reply + one timeout opens the breaker, although the
//    module promises "one answer resets the count completely" and "it never
//    trips on a refusal".

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const DUID = "duid-a70";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("one silent get_map_v1 is one strike", () => {
  test("three unanswered live-room fetches do not close live-room tracking", async () => {
    const { api, sent } = createRealRoborockOnFakeWire({ transport: "cloud" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // 18 = segment cleaning, a state the live-room fetch runs in.
      const fetch = api.refreshClassicLiveRoom(DUID, { v1State: 18 });
      // Let the request's own timeout fire, and clear the 10 s fetch gap.
      await jest.advanceTimersByTimeAsync(60_000);
      await fetch;
    }

    // Three requests went on the wire, and each one drew no reply.
    expect(sent.filter((entry) => entry.method === "get_map_v1")).toHaveLength(
      3
    );

    const entry = api.unansweredMethods.entries.get(`${DUID}:get_map_v1`);
    // Fails on 3.34.0: failures is 6 (each timeout counted twice) and the
    // breaker is open for six hours.
    expect(entry?.failures).toBe(3);
    expect(api.unansweredMethods.shouldSkip(DUID, "get_map_v1")).toBe(false);
  });
});

describe("a robot that answers with an error has answered", () => {
  /**
   * Feed the local dispatcher the decoded frame a robot sends when it
   * declines a request — the shape describeReplyRefusal documents for #22's
   * a144 (`Not FCC robot (code -10007)`).
   */
  function deliverLocalRefusal(api, duid, id) {
    api.message._decodeMsg = jest.fn(() => ({
      protocol: 4,
      payload: JSON.stringify({
        t: 1727000000,
        dps: {
          102: JSON.stringify({
            id,
            error: { code: -10007, message: "Not FCC robot" },
          }),
        },
      }),
    }));
    api.localConnector.processLocalSegment(duid, 120, Buffer.alloc(120));
  }

  test("an error reply between timeouts resets the run, so the breaker stays shut", async () => {
    const wire = createRealRoborockOnFakeWire({ transport: "cloud" });
    const { api, sent } = wire;
    const METHOD = "get_server_timer";
    // pollParameter's claim, exactly as it makes it.
    api.unansweredMethods.govern(DUID, METHOD);

    const timeOut = async () => {
      const request = api.messageQueueHandler
        .sendRequest(DUID, METHOD, [])
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(30_000);
      return request;
    };

    for (let i = 0; i < 5; i += 1) {
      const error = await timeOut();
      expect(error.unansweredRequest).toBe(true);
    }

    // The robot answers this one — with a refusal.
    wire.setTransport("local");
    const refused = api.messageQueueHandler
      .sendRequest(DUID, METHOD, [])
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(0);
    deliverLocalRefusal(api, DUID, sent[sent.length - 1].id);
    const refusal = await refused;
    expect(String(refusal?.message)).toMatch(/refused get_server_timer/);

    // And one more silence.
    wire.setTransport("cloud");
    await timeOut();

    // Fails on 3.34.0: the refusal did not reset the run, the count reads 6
    // and the method is skipped for six hours.
    expect(api.unansweredMethods.shouldSkip(DUID, METHOD)).toBe(false);
  });
});
