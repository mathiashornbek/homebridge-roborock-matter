"use strict";

// The late-reply / give-up-verdict rules, as found in review of 3.35.0. Each test drives
// the REAL Roborock instance, its REAL messageQueueHandler timeouts and its
// REAL reply dispatchers (local protocol 4, B01 msgId correlation); only the
// wire and the cipher are faked (test-support/real-roborock-wire.js).

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");
const {
  resolveB01PendingResponse,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "duid-review";

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** The decoded local frame a robot sends back, as the dispatcher reads it. */
function deliverLocalReply(api, id, result = []) {
  api.message._decodeMsg = jest.fn(() => ({
    protocol: 4,
    payload: JSON.stringify({
      t: 1727000000,
      dps: { 102: JSON.stringify({ id, result }) },
    }),
  }));
  api.localConnector.processLocalSegment(DUID, 120, Buffer.alloc(120));
}

async function timeOut(api, method) {
  const request = api.messageQueueHandler
    .sendRequest(DUID, method, [])
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(30_000);
  return request;
}

function giveUpLine(log, method) {
  return log.info.mock.calls
    .map(([line]) => line)
    .find((line) =>
      new RegExp(`has not answered ${method} \\d+ times`).test(line)
    );
}

describe("the give-up verdict describes THIS run of silences", () => {
  test("one late reply hours ago does not turn six later silences into 'too slow'", async () => {
    const { api, sent, log } = createRealRoborockOnFakeWire({
      transport: "local",
    });
    const METHOD = "get_server_timer";
    api.unansweredMethods.govern(DUID, METHOD);
    // Production wires this to the platform; a successful local reply calls it.
    api.deviceNotify = jest.fn();

    // Morning: one request times out and its reply turns up two seconds late.
    await timeOut(api, METHOD);
    deliverLocalReply(api, sent[sent.length - 1].id);
    expect(api.lateReplies.count(DUID, METHOD)).toBe(1);

    // Then the robot answers normally for a while — the register resets.
    const answered = api.messageQueueHandler
      .sendRequest(DUID, METHOD, [])
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(0);
    deliverLocalReply(api, sent[sent.length - 1].id, [1]);
    await answered;
    expect(api.unansweredMethods.entries.has(`${DUID}:${METHOD}`)).toBe(false);

    // Hours later it goes completely silent: six timeouts, no reply at all.
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    for (let i = 0; i < 6; i += 1) {
      await timeOut(api, METHOD);
    }

    const line = giveUpLine(log, METHOD);
    expect(line).toBeDefined();
    // Fails on r3350: "1 reply to get_server_timer did arrive, but only after
    // the plugin had stopped waiting (10 seconds), so the robot IS answering,
    // just too slowly to be used." — not one of these six was answered.
    expect(line).not.toMatch(/did arrive/);
  });
});

describe("the give-up verdict for a B01 method", () => {
  test("a Q7 that answers every get_map_list late is not called 'not arriving at all'", async () => {
    const { api, sent, log } = createRealRoborockOnFakeWire({
      transport: "cloud",
    });
    api.getRobotVersion = jest.fn(async () => "B01");
    // What home data says for a B01 robot; isB01Device() reads it.
    const realDeviceInfo = api.getVacuumDeviceInfo.bind(api);
    api.getVacuumDeviceInfo = jest.fn((duid, property) =>
      property === "pv" ? "B01" : realDeviceInfo(duid, property)
    );
    api.getProductAttribute = jest.fn((duid, attribute) =>
      attribute === "model" ? "roborock.vacuum.sc05" : undefined
    );
    // An unmatched B01 frame schedules a status refresh; keep it off the wire.
    api.getStatus = jest.fn(async () => undefined);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const fetch = api.refreshB01LiveRoom(DUID);
      await jest.advanceTimersByTimeAsync(11_000);
      await fetch;
      // The robot's reply to that get_map_list, two seconds too late, exactly
      // as the MQTT 102 handler hands it to the B01 correlator.
      const request = sent[sent.length - 1];
      expect(request.method).toBe("service.get_map_list");
      resolveB01PendingResponse(api, DUID, {
        msgId: request.id,
        code: 0,
        method: "service.get_map_list",
        data: { map_list: [{ id: 1, cur: true }] },
      });
      // Clear the live-room fetch gap / backoff before the next attempt.
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    }

    const line = giveUpLine(log, "get_map_list");
    expect(line).toBeDefined();
    // Fails on r3350: the line says "No late reply to get_map_list has arrived
    // either, so the reply is not arriving at all rather than arriving late" —
    // although six replies arrived late. B01 late replies are never measured
    // (resolveB01PendingResponse treats them as unsolicited pushes, and the
    // timeout records them under the wire name service.get_map_list).
    expect(line).not.toMatch(/not arriving at all/);
  });
});

describe("shutdown is not an answer", () => {
  test("stopping Homebridge mid-retry does not announce the robot answers again", async () => {
    const { api, log } = createRealRoborockOnFakeWire({ transport: "local" });
    const METHOD = "get_server_timer";
    api.unansweredMethods.govern(DUID, METHOD);

    for (let i = 0; i < 6; i += 1) {
      await timeOut(api, METHOD);
    }
    expect(giveUpLine(log, METHOD)).toBeDefined();

    // Six hours later the breaker lets its one retry through...
    await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 1);
    expect(api.unansweredMethods.shouldSkip(DUID, METHOD)).toBe(false);
    const retry = api.messageQueueHandler
      .sendRequest(DUID, METHOD, [])
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(0);

    // ...and Homebridge is stopped while it is still outstanding.
    await api.stopService();
    const error = await retry;
    expect(String(error?.message)).toMatch(/shutting down/);

    // Fails on r3350: the shutdown rejection goes through the wrapped stored
    // reject, which calls noteRequestAnswered — so the log says
    // "Robot duid-review answers get_server_timer again; it is back in the
    // normal poll cycle." about a robot that never replied.
    const claimed = log.info.mock.calls
      .map(([line]) => line)
      .filter((line) => /answers get_server_timer again/.test(line));
    expect(claimed).toEqual([]);
  });
});
