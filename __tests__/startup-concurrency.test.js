const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const { vacuum } = require("../roborockLib/lib/vacuum");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "startup-")),
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Startup wall-clock is dominated by waits the plugin does not control (a
// fixed-window LAN broadcast listen, one cloud round-trip per robot). These
// tests pin the concurrency down: a regression that re-serializes them would
// silently add seconds to every Homebridge restart, which is exactly the kind
// of slowdown nobody notices in review.
//
// They pin it *structurally*, not by the clock. Both tests used to assert
// `elapsed < PROBE_MS * robots` alongside the peak-concurrency check, and that
// comparison could only ever fail for a reason it was not testing: measured on
// a quiet machine the probes finish in ~65 ms against a 180 ms budget, but a
// scheduling hiccup pushes a run past 250 ms with the concurrency itself
// perfectly correct. That is the same defect 3.4.2 removed from the B01
// full-chain simulation — a test whose wall-clock time was never the thing it
// set out to verify — and here it was outright redundant: serialized probes
// give a peak concurrency of 1, which `peakConcurrent` already catches
// exactly, deterministically, on any machine under any load.
//
// `probeOrder` states the property directly instead: every probe must have
// started before the first one finished. Nothing else is what "at once" means.

/**
 * Records probe start/finish events so a test can assert that the starts all
 * happened before any finish.
 */
function createProbeOrder() {
  /** @type {string[]} */
  const events = [];

  return {
    events,
    start: (duid) => events.push(`start:${duid}`),
    finish: (duid) => events.push(`finish:${duid}`),
    /** True when every start precedes the earliest finish. */
    fullyOverlapped(count) {
      const firstFinish = events.findIndex((event) =>
        event.startsWith("finish:")
      );
      const startsBeforeFirstFinish = (
        firstFinish === -1 ? events : events.slice(0, firstFinish)
      ).filter((event) => event.startsWith("start:")).length;

      return startsBeforeFirstFinish === count;
    },
  };
}

describe("startup: per-robot probes run concurrently", () => {
  test("getNetworkInfo probes every robot at once, not one after another", async () => {
    const api = createApi();
    const PROBE_MS = 60;
    const duids = ["duid-a", "duid-b", "duid-c"];
    let concurrent = 0;
    let peakConcurrent = 0;
    const order = createProbeOrder();

    api.devices = duids.map((duid) => ({ duid }));
    for (const duid of duids) {
      api.initializedVacuumDuids.add(duid);
      api.vacuums[duid] = {
        getParameter: jest.fn(async () => {
          concurrent += 1;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          order.start(duid);
          await delay(PROBE_MS);
          order.finish(duid);
          concurrent -= 1;
        }),
      };
    }

    await api.getNetworkInfo();

    expect(peakConcurrent).toBe(duids.length);
    // Serialized probes would start the second only after the first finished.
    expect(order.fullyOverlapped(duids.length)).toBe(true);
    for (const duid of duids) {
      expect(api.vacuums[duid].getParameter).toHaveBeenCalledWith(
        duid,
        "get_network_info"
      );
    }
  });

  test("one robot failing its probe does not skip the others", async () => {
    const api = createApi();
    const duids = ["duid-a", "duid-b"];
    api.devices = duids.map((duid) => ({ duid }));
    for (const duid of duids) {
      api.initializedVacuumDuids.add(duid);
    }
    api.vacuums["duid-a"] = {
      getParameter: jest.fn(async () => {
        throw new Error("robot offline");
      }),
    };
    api.vacuums["duid-b"] = { getParameter: jest.fn(async () => undefined) };

    await expect(api.getNetworkInfo()).resolves.toBeUndefined();
    expect(api.vacuums["duid-b"].getParameter).toHaveBeenCalled();
  });

  test("initializeDeviceUpdates overlaps the first poll of each robot", async () => {
    const api = createApi();
    const POLL_MS = 60;
    const duids = ["duid-a", "duid-b", "duid-c"];
    let concurrent = 0;
    let peakConcurrent = 0;
    const order = createProbeOrder();

    api.devices = duids.map((duid) => ({ duid, online: true }));
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a999");
    api.updateDataMinimumData = jest.fn(async (duid) => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      order.start(duid);
      await delay(POLL_MS);
      order.finish(duid);
      concurrent -= 1;
    });
    for (const duid of duids) {
      api.initializedVacuumDuids.add(duid);
      api.vacuums[duid] = {};
    }

    await api.initializeDeviceUpdates();

    expect(api.updateDataMinimumData).toHaveBeenCalledTimes(duids.length);
    expect(peakConcurrent).toBe(duids.length);
    expect(order.fullyOverlapped(duids.length)).toBe(true);

    // The recurring timers must still be wired up for every robot.
    for (const duid of duids) {
      expect(typeof api.vacuums[duid].mainUpdateInterval).toBe("function");
      expect(typeof api.vacuums[duid].getStatusIntervall).toBe("function");
    }
    await api.stopService();
  });
});

// Regression guard for a gate that was dead on arrival: it tested
// `config.updateInterval` (never set by this plugin) and `adapter.socket`
// (permanently null), so `NaN == 0` made the periodic status refresh
// unreachable. Classic robots were left with MQTT push and a 3-minute full
// poll as their only sources of truth.
describe("periodic status refresh actually fires", () => {
  function createRobot() {
    const adapter = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "poll-")),
    });
    adapter.messageQueueHandler = {
      sendRequest: jest.fn(async () => [{ state: 8, battery: 100 }]),
    };
    adapter.getObjectAsync = jest.fn(async () => ({}));
    adapter.setStateAsync = jest.fn(async () => undefined);
    adapter.updateRoborockDiagnostics = jest.fn(async () => undefined);
    adapter.isCleaning = jest.fn(() => false);
    adapter.vacuums["duid-1"] = {
      features: { hasDeviceStatusAttribute: () => true },
    };
    const robot = new vacuum(adapter, "roborock.vacuum.a70");
    return { adapter, robot };
  }

  test("the first tick polls, the next one within the window does not", async () => {
    const { adapter, robot } = createRobot();

    await robot.getParameter("duid-1", "get_status", "state");
    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "duid-1",
      "get_prop",
      ["get_status"],
      false,
      false,
      {}
    );

    await robot.getParameter("duid-1", "get_status", "state");
    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
  });

  test("the throttle opens again once the window has passed", async () => {
    const { adapter, robot } = createRobot();

    await robot.getParameter("duid-1", "get_status", "state");
    robot.lastStatusPollAt.set("duid-1", Date.now() - 61 * 1000);
    await robot.getParameter("duid-1", "get_status", "state");

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
  });

  test("an explicit force always bypasses the throttle", async () => {
    const { adapter, robot } = createRobot();

    await robot.getParameter("duid-1", "get_status", "force");
    await robot.getParameter("duid-1", "get_status", "force");
    await robot.getParameter("duid-1", "get_status", "force");

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(3);
  });

  test("each robot is throttled on its own clock", async () => {
    const { adapter, robot } = createRobot();
    adapter.vacuums["duid-2"] = adapter.vacuums["duid-1"];

    await robot.getParameter("duid-1", "get_status", "state");
    await robot.getParameter("duid-2", "get_status", "state");

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(2);
  });
});
