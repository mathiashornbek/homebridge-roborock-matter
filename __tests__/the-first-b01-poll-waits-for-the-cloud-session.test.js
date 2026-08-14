const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// The first B01 status request of every startup was refused, on every single
// restart, on every Q7 in the house — 92 out of 92 observed startups, always
// exactly one failed attempt, never two, and never later than 32 seconds in.
//
// That signature is not a flaky connection. A flaky connection gives a varying
// number of attempts at varying times; one attempt, every time, only at boot,
// only on the cloud-only protocol is a race, and the race is an ordering
// mistake in the startup sequence:
//
//   await this.updateHomeData(homeId);
//   await this.createDevices();                        // started the B01 loop,
//                                                      // whose first poll is
//                                                      // issued immediately
//   await this.rr_mqtt_connector.waitUntilConnected(); // ...only now is the
//                                                      // cloud session up
//
// A B01 request is cloud-only by construction (`useCloudConnection` is true for
// the protocol, unconditionally), so sendRequest took the
// `!mqttConnectionState && useCloudConnection` branch and rejected it with
// "cloud unavailable" before anything went on the wire. The comment above that
// await already spells the hazard out for its two neighbours; the loop start
// had simply slipped in front of it.
//
// The 27-second wrong tile in Apple Home is the same event seen from the other
// end. The refused attempt still stamps the throttle, so the 15s tick that
// follows is inside the 25s idle gap and is dropped, and the robot's real
// status does not land until the tick at ~30s. Measured median: 31 seconds.
//
// These tests pin the rule rather than the incident: no poll may be issued
// into a cloud session that is not up, and the loop must not be started before
// the sequence has waited for that session.

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
  "utf8"
);

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * A Roborock instance holding one B01 robot and one classic robot, with the
 * cloud session in a known state.
 *
 * @param {{cloudSessionUp: boolean}} options
 */
function createApiWithB01({ cloudSessionUp }) {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-first-poll-")),
  });

  api.initializedVacuumDuids = new Set(["q7", "classic"]);
  api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
    attr === "pv" ? (duid === "q7" ? "B01" : "1.0") : ""
  );
  api.getStatus = jest.fn().mockResolvedValue(undefined);
  api.manageDeviceIntervals = jest.fn().mockResolvedValue(true);
  api.rr_mqtt_connector.connected = cloudSessionUp;

  return api;
}

describe("the first B01 poll is not issued into a cloud session that is down", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("the boot poll is skipped while the cloud session is still coming up", () => {
    jest.useFakeTimers();
    const api = createApiWithB01({ cloudSessionUp: false });

    api.startB01StatusLoop();

    expect(api.getStatus).not.toHaveBeenCalled();
  });

  test("the boot poll still fires when the cloud session is already up", () => {
    jest.useFakeTimers();
    const api = createApiWithB01({ cloudSessionUp: true });

    api.startB01StatusLoop();

    expect(api.getStatus).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenCalledWith("q7", { force: true });
  });

  test("skipping the boot poll does not stop the loop from being armed", () => {
    jest.useFakeTimers();
    const api = createApiWithB01({ cloudSessionUp: false });

    api.startB01StatusLoop();

    expect(api.b01StatusLoopHandle).toBeTruthy();
  });

  // The whole point of skipping rather than sending: a request that is never
  // sent cannot stamp the attempt throttle, so the very next tick gets through
  // instead of being dropped inside the idle gap.
  test("the skipped poll does not delay the first real one to the second tick", () => {
    jest.useFakeTimers();
    const api = createApiWithB01({ cloudSessionUp: false });

    api.startB01StatusLoop();
    api.rr_mqtt_connector.connected = true;
    jest.advanceTimersByTime(15100);

    expect(api.getStatus).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenCalledWith("q7", undefined);
  });

  test("a robot that is not on the B01 protocol is never polled by this loop", () => {
    jest.useFakeTimers();
    for (const cloudSessionUp of [true, false]) {
      const api = createApiWithB01({ cloudSessionUp });
      api.startB01StatusLoop();
      jest.advanceTimersByTime(45100);

      const polledDuids = api.getStatus.mock.calls.map(([duid]) => duid);
      expect(polledDuids).not.toContain("classic");
    }
  });

  // Guard against a passing suite that proves nothing: if the loop stopped
  // polling altogether, every assertion above except this one would still hold.
  test("the loop does eventually poll the B01 robot in both session states", () => {
    jest.useFakeTimers();
    for (const cloudSessionUp of [true, false]) {
      const api = createApiWithB01({ cloudSessionUp });
      api.startB01StatusLoop();
      api.rr_mqtt_connector.connected = true;
      jest.advanceTimersByTime(15100);

      const polledDuids = api.getStatus.mock.calls.map(([duid]) => duid);
      expect(polledDuids).toContain("q7");
    }
  });

  // A caller whose connector cannot answer the question at all must not lose
  // its boot poll — an unknown session is treated as usable, exactly as before.
  test("a connector that cannot report its state keeps the boot poll", () => {
    jest.useFakeTimers();
    const api = createApiWithB01({ cloudSessionUp: false });
    api.rr_mqtt_connector = /** @type {any} */ ({});

    api.startB01StatusLoop();

    expect(api.getStatus).toHaveBeenCalledWith("q7", { force: true });
  });
});

describe("no failed attempt is recorded for a startup that simply had to wait", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * A Roborock whose real refresh path runs against a cloud that answers only
   * once the session is up — the same contract sendRequest enforces.
   */
  function createApiWithLiveRefreshPath() {
    const api = createApiWithB01({ cloudSessionUp: false });
    delete api.getStatus;
    api.getRobotVersion = jest.fn().mockResolvedValue("B01");
    api.vacuums = { q7: {}, classic: {} };
    api.describeDevice = () => "1. Sal";
    // The refresh dispatches every successful status on the live-message path,
    // and a throw from there is counted as a failed status attempt. Without
    // this the harness would manufacture the very failure under test.
    api.deviceNotify = jest.fn();
    api.messageQueueHandler = {
      sendRequest: jest.fn(async () => {
        if (!api.rr_mqtt_connector.connected) {
          throw new Error(
            "The Roborock cloud connection is not available, so the get_status request was not sent."
          );
        }
        return { state: 8, battery: 100, charge_status: 1 };
      }),
    };
    return api;
  }

  /**
   * Brings the cloud session up part-way into the run, the way a real broker
   * handshake does.
   *
   * Flipping the flag synchronously right after startB01StatusLoop() would not
   * reproduce anything: the boot poll reaches sendRequest a microtask later,
   * by which time the session would already be up, and the bug would hide.
   * The handshake has to still be in flight when the poll goes out.
   */
  function bringSessionUpAfter(api, ms) {
    setTimeout(() => {
      api.rr_mqtt_connector.connected = true;
    }, ms);
  }

  // The symptom exactly as it stood in the log, stated as an assertion:
  // "B01 status for 1. Sal recovered after 1 failed attempt(s)." — once per Q7
  // per restart, 92 times out of 92. Nothing about the robot warranted it.
  //
  // The window has to reach past the SECOND tick: on the unfixed code the
  // retry is dropped by the idle throttle at 15s and only gets through at 30s,
  // which is where the recovery line was actually printed. Asserting over a
  // 15s window would have passed for the wrong reason.
  test("starting the loop before the session is up logs no recovery line", async () => {
    jest.useFakeTimers();
    const api = createApiWithLiveRefreshPath();

    bringSessionUpAfter(api, 5000);
    api.startB01StatusLoop();
    await jest.advanceTimersByTimeAsync(31000);

    const recoveryLines = api.log.info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("recovered after"));
    expect(recoveryLines).toEqual([]);
    expect(api._b01StatusState.get("q7").consecutiveFailures).toBe(0);
  });

  // The other end of the same event: the 27 seconds during which Apple Home
  // showed the registration snapshot instead of the robot. The real status has
  // to land at the first tick, not the second.
  test("the robot's real status lands at the first tick, not the second", async () => {
    jest.useFakeTimers();
    const api = createApiWithLiveRefreshPath();

    bringSessionUpAfter(api, 5000);
    api.startB01StatusLoop();
    await jest.advanceTimersByTimeAsync(15100);

    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "q7",
      "get_status",
      []
    );
    // Not just attempted — landed. The refresh only records a status once the
    // response has been mapped to the v1 shape the accessory reads.
    expect(api._b01StatusState.get("q7").lastV1Status).toBeTruthy();
    expect(api._b01StatusState.get("q7").consecutiveFailures).toBe(0);
  });
});

describe("the startup sequence waits for the cloud session before starting the loop", () => {
  /** The body of a method, from its declaration to the next one at the same indent. */
  function methodBody(name) {
    const start = SOURCE.indexOf(`\n  async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf("\n  async ", start + 1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  // The ordering hazard is invisible from inside createDevices(): the call
  // looks harmless there, and the wait it needs lives in a different method.
  // This is the assertion that stops it moving back.
  test("createDevices does not start the B01 status loop", () => {
    expect(methodBody("createDevices")).not.toContain("startB01StatusLoop");
  });

  test("the loop is started after the wait for the cloud session, not before", () => {
    const sequenceStart = SOURCE.indexOf("await this.createDevices();");
    const sequenceEnd = SOURCE.indexOf("this.bInited = true;");
    expect(sequenceStart).toBeGreaterThan(-1);
    expect(sequenceEnd).toBeGreaterThan(sequenceStart);

    const sequence = SOURCE.slice(sequenceStart, sequenceEnd);
    const waitIndex = sequence.indexOf(
      "await this.rr_mqtt_connector.waitUntilConnected();"
    );
    const loopIndex = sequence.indexOf("this.startB01StatusLoop();");

    // Guards against an empty pass: -1 < -1 is false, but -1 < n is true, and
    // a slice missing both anchors would sail through a bare comparison.
    expect(waitIndex).toBeGreaterThan(-1);
    expect(loopIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(loopIndex);
  });

  test("the loop start still runs after the devices it polls exist", () => {
    const sequence = SOURCE.slice(
      SOURCE.indexOf("await this.createDevices();"),
      SOURCE.indexOf("this.bInited = true;")
    );
    expect(sequence.indexOf("await this.createDevices();")).toBeLessThan(
      sequence.indexOf("this.startB01StatusLoop();")
    );
  });
});
