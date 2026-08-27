const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// What this pins down, and why it is written as a rule rather than as three
// separate cases:
//
// clearLiveRoomForDevice runs at every cleaning-run boundary and its stated job
// is that nothing leaks into the next run. It used to drop only the cached
// room, so every OTHER piece of per-run state survived for the lifetime of the
// Homebridge process. Three user-visible log lines were wrong as a direct
// result:
//
//   "…: <reason> (attempt N this run…)"      — N counted every run since start
//   the once-per-run placeholder explanation — only ever seen on the 1st run
//   "…failed N times in a row…"              — could open a run already at 5
//
// The fix resets the counters, and the last test here enumerates the rule
// across both protocol paths instead of trusting that the two call sites were
// both remembered. A robot that failed every single attempt is exactly the
// robot that leaves the counters high, so the reset has to happen even when no
// room was ever resolved — hence `current: null` in the fixtures below.

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "live-room-run-")),
  });
  api.describeDevice = jest.fn((duid) => `robot ${duid}`);
  return api;
}

// The per-run counters, and the value each must hold at the start of a run.
const RUN_COUNTERS = {
  consecutiveFailures: 0,
  unresolvedPoseCount: 0,
  placeholderReported: false,
};

function dirtyState(overrides = {}) {
  return {
    lastAttemptAt: 0,
    inflight: null,
    consecutiveFailures: 7,
    unresolvedPoseCount: 12,
    placeholderReported: true,
    current: null,
    ...overrides,
  };
}

describe("a finished run leaves no per-run live-room state behind", () => {
  test("the classic path resets the counters even when no room was ever resolved", () => {
    const api = createApi();
    api._classicLiveRoomState = new Map([["duid-s8", dirtyState()]]);

    api.clearLiveRoomForDevice("duid-s8");

    expect(api._classicLiveRoomState.get("duid-s8")).toMatchObject(
      RUN_COUNTERS
    );
  });

  test("the B01 path resets the counters even when no room was ever resolved", () => {
    const api = createApi();
    api._b01LiveRoomState = new Map([["q7", dirtyState()]]);

    api.clearB01LiveRoom("q7");

    expect(api._b01LiveRoomState.get("q7")).toMatchObject(RUN_COUNTERS);
  });

  test("a resolved room is still dropped, and the counters go with it", () => {
    const api = createApi();
    api._classicLiveRoomState = new Map([
      [
        "duid-s8",
        dirtyState({
          current: { segmentId: 16, roomName: "Køkken", at: Date.now() },
        }),
      ],
    ]);

    api.clearLiveRoomForDevice("duid-s8");

    const state = api._classicLiveRoomState.get("duid-s8");
    expect(state.current).toBeNull();
    expect(state).toMatchObject(RUN_COUNTERS);
  });

  // The rule, not the two cases: every live-room state map the class keeps must
  // be reset by the one call the accessory makes at a run boundary. A third
  // protocol path added later fails here instead of leaking silently.
  test("clearLiveRoomForDevice resets every live-room state map the class keeps", () => {
    const api = createApi();
    const maps = ["_classicLiveRoomState", "_b01LiveRoomState"];
    for (const name of maps) {
      api[name] = new Map([["duid-x", dirtyState()]]);
    }

    api.clearLiveRoomForDevice("duid-x");

    for (const name of maps) {
      expect(api[name].get("duid-x")).toMatchObject(RUN_COUNTERS);
    }
  });

  test("clearing a device the plugin has never tracked does not throw", () => {
    const api = createApi();
    expect(() => api.clearLiveRoomForDevice("never-seen")).not.toThrow();
  });
});

describe("a live-room channel that keeps failing is not hammered", () => {
  // Read the named constants out of the source rather than restating the
  // numbers here, so this test has an opinion about the SHAPE of the backoff
  // and not about a value someone is allowed to tune. Read per test, not once
  // per file: a missing constant should fail the assertions that depend on it
  // rather than the whole file's collection.
  function constants() {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
      "utf8"
    );
    const read = (name) => {
      const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
      if (!match) {
        throw new Error(`roborockAPI.js declares no ${name}`);
      }
      return Number(match[1]);
    };
    return {
      base: read("B01_LIVE_ROOM_MIN_FETCH_GAP_MS"),
      after: read("LIVE_ROOM_FAILURE_BACKOFF_AFTER"),
      cap: read("LIVE_ROOM_FAILURE_BACKOFF_MAX_MS"),
    };
  }

  function gapAfter(failures) {
    const api = createApi();
    const state = { lastAttemptAt: 0, inflight: null, consecutiveFailures: 0 };
    api._b01LiveRoomState = new Map([["q7", state]]);
    // refreshB01LiveRoom's throttle is the only consumer of the gap, so drive
    // it through the real function: a fetch is attempted iff enough time has
    // passed. sendRequest is the tripwire.
    state.consecutiveFailures = failures;
    let attempted = false;
    api.messageQueueHandler = {
      sendRequest: jest.fn(async () => {
        attempted = true;
        throw new Error("cloud down");
      }),
    };
    return async (elapsedMs) => {
      attempted = false;
      state.consecutiveFailures = failures;
      state.lastAttemptAt = Date.now() - elapsedMs;
      state.inflight = null;
      await api.refreshB01LiveRoom("q7");
      return attempted;
    };
  }

  test("the first failures are not slowed down at all", async () => {
    const { base, after } = constants();
    for (let failures = 0; failures <= after; failures += 1) {
      const attempt = gapAfter(failures);
      expect(await attempt(base + 1)).toBe(true);
    }
  });

  test("past the threshold the gap widens with each further failure", async () => {
    const { base, after } = constants();
    // One past the threshold: the base gap is no longer enough...
    const justOver = gapAfter(after + 1);
    expect(await justOver(base + 1)).toBe(false);
    // ...but twice the base is.
    expect(await gapAfter(after + 1)(base * 2 + 1)).toBe(true);

    // Two past: twice the base is no longer enough either.
    expect(await gapAfter(after + 2)(base * 2 + 1)).toBe(false);
  });

  test("the backoff is capped, so the channel is still retried", async () => {
    const { after, cap } = constants();
    const hopeless = gapAfter(after + 40); // 2**40 would be geological
    // Probed a second either side of the cap rather than a millisecond.
    // `lastAttemptAt` is stamped from the real clock here and the throttle
    // reads the real clock again inside the call, so the elapsed time the
    // throttle sees is the requested figure PLUS however long the call takes
    // to get there. At a 1 ms margin any work added ahead of the throttle —
    // the Q10 family check now sits there — pushes `cap - 1` over the line and
    // the assertion flips, which is a property of the test rig rather than of
    // the backoff. A second still pins a 5-minute cap to within 0.3 %, and the
    // doubling either side of it is pinned by the test above.
    expect(await hopeless(cap - 1000)).toBe(false);
    expect(await hopeless(cap + 1000)).toBe(true);
  });

  test("a successful fetch drops straight back to the live cadence", () => {
    const { after } = constants();
    const api = createApi();
    const state = { consecutiveFailures: after + 5 };

    api.noteLiveRoomFetchRecovered("q7", state);

    expect(state.consecutiveFailures).toBe(0);
    // And it says so, because the failure streak was announced at warn level.
    expect(api.log.info).toHaveBeenCalledWith(
      expect.stringContaining("recovered after")
    );
  });

  test("a streak too short to have been slowed down recovers quietly", () => {
    const { after } = constants();
    const api = createApi();
    const state = { consecutiveFailures: after };

    api.noteLiveRoomFetchRecovered("q7", state);

    expect(state.consecutiveFailures).toBe(0);
    expect(api.log.info).not.toHaveBeenCalled();
  });
});
