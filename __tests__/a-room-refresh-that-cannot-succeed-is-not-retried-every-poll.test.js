"use strict";

// The THIRD loop that asks a robot for something the answer cannot arrive for.
//
// 3.19.0 gated the dedicated B01 status loop, 3.19.1 gated the live-room loop,
// and the send choke point's own comment names the class: "3.19.0 and 3.19.1
// were each one gate for one loop of exactly this class; the shape of the error
// is what kept producing them." The 6-hourly room-LIST refresh is the third,
// and it was missed both times.
//
// `refreshB01Rooms` sends `get_map_list`, which is not in NEUTRAL_RESPONSES and
// has no Q10 translation, so for an `ss*` the choke point refuses it by name
// and throws B01_METHOD_UNSUPPORTED. Its caller catches that at debug level and
// returns false — quiet, but the refusal is certain before it is asked, and the
// throttle that would normally space these out is stamped ONLY on success. A
// Q10 therefore never stamps it, so the guard never engages and the request is
// re-attempted by every periodic poll, forever.
//
// The same success-only stamp is the more expensive half on a Q7, where the
// request is NOT refused: a robot whose map channel is down runs a real
// `get_map_list` on the wire plus a map read that waits out its full 20 s
// timeout, once per poll cycle (180 s by default) — 480 guaranteed-to-fail
// attempts a day. That is the same reasoning already written down for the
// live-room loop and measured there on an a70 whose map channel was timing out.
//
// So this pins the class rather than either case: a refresh that cannot succeed
// must not be retried at poll cadence. And it pins the other half in both
// directions — a Q7 must still be fetched, and a recovered channel must drop
// straight back to the normal cadence, because Q7 is what runs on the
// maintainer's own three robots.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

const Q10_MODEL = "roborock.vacuum.ss07";
const Q7_MODEL = "roborock.vacuum.sc05";
const UNKNOWN_B01_MODEL = "roborock.vacuum.sc99";

const POLL_CADENCE_MS = 180000;

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi(model, sendRequestImpl) {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-roomrefresh-")),
  });
  api.getProductAttribute = jest.fn(() => model);
  api.getVacuumDeviceInfo = jest.fn((duid, key) =>
    key === "pv" ? "B01" : "serial-1"
  );
  api.describeDevice = jest.fn((duid) => `Saugroboter (${duid})`);

  const sendRequest = jest.fn(
    sendRequestImpl ||
      // A map list with no current map: enough to reach the wire and return
      // without needing a decodable map payload behind it.
      (async () => [{ mapFlag: 0, name: "Main" }])
  );
  api.messageQueueHandler = { sendRequest };
  return { api, log, sendRequest };
}

/** Drive the clock the throttle reads, so a test can say "one poll later"
 * without sleeping. */
function withClock() {
  // Start well past the 6-hour success throttle. A small epoch would leave
  // `Date.now() - 0` inside that window and every assertion below would pass
  // vacuously, on the throttle rather than on the behaviour under test.
  let now = 1_800_000_000_000;
  const spy = jest.spyOn(Date, "now").mockImplementation(() => now);
  return {
    advance(ms) {
      now += ms;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

describe("a Q10 room-list refresh is not attempted at all", () => {
  test("no request is sent for a Q10", async () => {
    const { api, sendRequest } = createApi(Q10_MODEL);

    const rooms = await api.refreshB01Rooms("duid-q10");

    expect(sendRequest).not.toHaveBeenCalled();
    expect(rooms).toEqual([]);
  });

  test("twenty poll cycles send nothing and throw nothing", async () => {
    const { api, sendRequest } = createApi(Q10_MODEL);
    const clock = withClock();
    try {
      // Well past the 6-hour success throttle, so a pass cannot come from the
      // throttle happening to still be closed.
      for (let index = 0; index < 20; index += 1) {
        clock.advance(POLL_CADENCE_MS);
        await expect(api.refreshB01Rooms("duid-q10")).resolves.toEqual([]);
      }
      clock.advance(7 * 60 * 60 * 1000);
      await expect(api.refreshB01Rooms("duid-q10")).resolves.toEqual([]);
    } finally {
      clock.restore();
    }

    expect(sendRequest).not.toHaveBeenCalled();
  });

  test("forcing a refresh does not make a Q10 reachable", async () => {
    const { api, sendRequest } = createApi(Q10_MODEL);

    await expect(
      api.refreshB01Rooms("duid-q10", { force: true })
    ).resolves.toEqual([]);

    expect(sendRequest).not.toHaveBeenCalled();
  });

  test("a Q7 is still fetched", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL);

    await api.refreshB01Rooms("duid-q7");

    expect(sendRequest).toHaveBeenCalledWith("duid-q7", "get_map_list", {});
  });

  test("an unknown B01 model is still treated as a Q7 and fetched", async () => {
    const { api, sendRequest } = createApi(UNKNOWN_B01_MODEL);

    await api.refreshB01Rooms("duid-unknown");

    expect(sendRequest).toHaveBeenCalledWith(
      "duid-unknown",
      "get_map_list",
      {}
    );
  });
});

describe("a failing room refresh backs off instead of retrying every poll", () => {
  /** Count how many attempts actually reach the wire across a run of polls. */
  async function attemptsOverPolls(api, duid, polls, clock) {
    for (let index = 0; index < polls; index += 1) {
      clock.advance(POLL_CADENCE_MS);
      await api.refreshB01Rooms(duid).catch(() => {});
    }
  }

  test("a channel that is down is not asked once per poll for a whole day", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL, async () => {
      throw new Error("B01 map request timed out after 20s");
    });
    const clock = withClock();
    try {
      // 480 polls is one full day at the default 180 s cadence.
      await attemptsOverPolls(api, "duid-q7", 480, clock);
    } finally {
      clock.restore();
    }

    // Without a failure backoff this is 480. With one it is bounded by the
    // 30-minute cap: 24 hours of polling can reach the wire at most ~50 times.
    expect(sendRequest.mock.calls.length).toBeLessThan(60);
    expect(sendRequest).toHaveBeenCalled();
  });

  test("the first failure is retried by the very next poll", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL, async () => {
      throw new Error("B01 map request timed out after 20s");
    });
    const clock = withClock();
    try {
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      expect(sendRequest).toHaveBeenCalledTimes(1);

      // A single lost frame on a healthy channel must not cost a room list.
      clock.advance(POLL_CADENCE_MS);
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      expect(sendRequest).toHaveBeenCalledTimes(2);
    } finally {
      clock.restore();
    }
  });

  test("the gap widens as failures pile up", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL, async () => {
      throw new Error("B01 map request timed out after 20s");
    });
    const clock = withClock();
    try {
      // Two failures, so the third attempt is the first that is slowed.
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      clock.advance(POLL_CADENCE_MS);
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      expect(sendRequest).toHaveBeenCalledTimes(2);

      // One poll later is now too soon.
      clock.advance(POLL_CADENCE_MS);
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      expect(sendRequest).toHaveBeenCalledTimes(2);

      // Two polls later it is allowed again.
      clock.advance(POLL_CADENCE_MS * 2);
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      expect(sendRequest).toHaveBeenCalledTimes(3);
    } finally {
      clock.restore();
    }
  });

  test("the backoff is capped well below the 6-hour success cadence", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL, async () => {
      throw new Error("B01 map request timed out after 20s");
    });
    const clock = withClock();
    try {
      // Pile up far more failures than the cap needs.
      for (let index = 0; index < 40; index += 1) {
        clock.advance(6 * 60 * 60 * 1000);
        await api.refreshB01Rooms("duid-q7").catch(() => {});
      }
      const before = sendRequest.mock.calls.length;

      // Half an hour after the last failure the channel is tried again, so a
      // robot that recovers is never stranded for a whole 6-hour cycle.
      clock.advance(30 * 60 * 1000);
      await api.refreshB01Rooms("duid-q7").catch(() => {});
      expect(sendRequest.mock.calls.length).toBe(before + 1);
    } finally {
      clock.restore();
    }
  });

  test("a success drops straight back to the normal cadence", async () => {
    let failing = true;
    const { api, sendRequest } = createApi(Q7_MODEL, async () => {
      if (failing) {
        throw new Error("B01 map request timed out after 20s");
      }
      return [{ mapFlag: 0, name: "Main" }];
    });
    const clock = withClock();
    try {
      for (let index = 0; index < 6; index += 1) {
        clock.advance(60 * 60 * 1000);
        await api.refreshB01Rooms("duid-q7").catch(() => {});
      }
      const afterFailures = sendRequest.mock.calls.length;

      // The channel answers. `findCurrentMapId` finds no current map, so no
      // rooms are cached — but the request itself succeeded, which is what the
      // failure counter is about.
      failing = false;
      clock.advance(30 * 60 * 1000);
      await api.refreshB01Rooms("duid-q7");
      expect(sendRequest.mock.calls.length).toBe(afterFailures + 1);

      // No accumulated penalty survives the success.
      clock.advance(POLL_CADENCE_MS);
      await api.refreshB01Rooms("duid-q7");
      expect(sendRequest.mock.calls.length).toBe(afterFailures + 2);
    } finally {
      clock.restore();
    }
  });

  test("a forced refresh ignores the failure backoff", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL, async () => {
      throw new Error("B01 map request timed out after 20s");
    });
    const clock = withClock();
    try {
      for (let index = 0; index < 5; index += 1) {
        clock.advance(60 * 60 * 1000);
        await api.refreshB01Rooms("duid-q7").catch(() => {});
      }
      const before = sendRequest.mock.calls.length;

      await api.refreshB01Rooms("duid-q7", { force: true }).catch(() => {});
      expect(sendRequest.mock.calls.length).toBe(before + 1);
    } finally {
      clock.restore();
    }
  });

  test("each robot backs off on its own", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL, async (duid) => {
      if (duid === "duid-bad") {
        throw new Error("B01 map request timed out after 20s");
      }
      return [{ mapFlag: 0, name: "Main" }];
    });
    const clock = withClock();
    try {
      for (let index = 0; index < 4; index += 1) {
        clock.advance(POLL_CADENCE_MS);
        await api.refreshB01Rooms("duid-bad").catch(() => {});
      }

      // The healthy robot is unaffected by its neighbour's dead channel.
      clock.advance(7 * 60 * 60 * 1000);
      const before = sendRequest.mock.calls.length;
      await api.refreshB01Rooms("duid-good");
      expect(sendRequest.mock.calls.length).toBe(before + 1);
    } finally {
      clock.restore();
    }
  });
});
