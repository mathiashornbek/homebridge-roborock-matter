"use strict";

// Field report: two Q7s started cleaning, reached runMode=1 in Apple Home at
// 09:33:58, and the first live room only appeared at 09:35:28 — 90 seconds
// later. The delay was the sum of two throttles: up to 45s before an
// app-started run was noticed at all, then up to a further 20s before the
// first map fetch was allowed. The first room of a run is exactly the moment
// someone is looking at the tile, so it must not wait for a throttle that
// exists to pace steady-state traffic.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function createApi() {
  return new Roborock({
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-latency-")),
  });
}

describe("B01 live-room responsiveness", () => {
  test("the first room of a run is fetched immediately, not after the map throttle", async () => {
    const api = createApi();
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    api.config = { debug: false };
    api.vacuums["duid-1"] = {};

    // The robot was idle a moment ago and a map fetch was attempted then, so
    // the throttle stamp is fresh.
    api._b01LiveRoomState = new Map([
      [
        "duid-1",
        {
          lastAttemptAt: Date.now(),
          inflight: null,
          consecutiveFailures: 0,
          current: null,
        },
      ],
    ]);

    const fetched = [];
    api.refreshB01LiveRoom = jest.fn(async (duid) => {
      fetched.push({
        duid,
        stampWhenCalled: api._b01LiveRoomState.get(duid).lastAttemptAt,
      });
      return null;
    });

    // status 5 => v1 state 5 (cleaning), which is a live-room fetch state.
    api.messageQueueHandler = {
      sendRequest: jest.fn().mockResolvedValue({ status: 5, quantity: 97 }),
    };

    await api.refreshB01Status("duid-1", { force: true });

    // The transition must clear the throttle stamp so the first fetch of the
    // run is allowed through immediately rather than waiting out a gap that
    // exists to pace steady-state traffic.
    expect(api._b01LiveRoomState.get("duid-1").lastAttemptAt).toBe(0);
    void fetched;
  });

  test("the throttle is left alone while a run continues", async () => {
    const api = createApi();
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    api.config = { debug: false };
    api.vacuums["duid-1"] = {};

    const stamp = Date.now();
    api._b01LiveRoomState = new Map([
      [
        "duid-1",
        {
          lastAttemptAt: stamp,
          inflight: null,
          consecutiveFailures: 0,
          current: null,
        },
      ],
    ]);
    api.refreshB01LiveRoom = jest.fn().mockResolvedValue(null);
    api.messageQueueHandler = {
      sendRequest: jest.fn().mockResolvedValue({ status: 5, quantity: 97 }),
    };

    // Already cleaning before this poll: no transition, so steady-state
    // pacing must survive untouched.
    api._b01StatusState = new Map([
      [
        "duid-1",
        {
          lastAttemptAt: 0,
          inflight: null,
          consecutiveFailures: 0,
          lastKnownV1State: 5,
        },
      ],
    ]);
    await api.refreshB01Status("duid-1", { force: true });

    expect(api._b01LiveRoomState.get("duid-1").lastAttemptAt).toBe(stamp);
  });

  test("cadence constants keep a live display actually live", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
      "utf8"
    );

    const gap = Number(
      /const B01_LIVE_ROOM_MIN_FETCH_GAP_MS = (\d+);/.exec(source)[1]
    );
    // Read the named constant rather than the shape of the expression that
    // uses it: this assertion used to match the literals inline and broke the
    // moment they were given names, which is a change it should not have had
    // an opinion about.
    const idle = Number(
      /const B01_STATUS_IDLE_GAP_MS = (\d+);/.exec(source)[1]
    );
    const active = Number(
      /const B01_STATUS_ACTIVE_GAP_MS = (\d+);/.exec(source)[1]
    );

    // A room the robot has already left is worse than no room at all.
    expect(gap).toBeLessThanOrEqual(10000);
    // Worst case before an app-started run is noticed.
    expect(idle).toBeLessThanOrEqual(25000);
    // ...but not so eager that an parked robot is polled constantly.
    expect(idle).toBeGreaterThanOrEqual(15000);
    // A running robot must never be polled less often than a parked one.
    expect(active).toBeLessThan(idle);
  });
});
