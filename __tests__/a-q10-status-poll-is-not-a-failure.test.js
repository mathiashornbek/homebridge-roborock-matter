"use strict";

// A Q10 (`ss*`) sends no reply to a status read — that is the dialect, not a
// fault. 3.19.0-beta.1 taught the send choke point to refuse such a request by
// name, but the dedicated B01 status loop was never told, so it kept asking
// every 25 seconds. Each attempt was refused before it reached the wire, each
// refusal counted as a consecutive failure, and every tenth one logged
// "B01 status has failed N times in a row" at warn level.
//
// niclasreich's `ss07` (#14) is the only Q10 in the field, and the first thing
// the beta build put in his log was that warning climbing — a plugin reporting
// its own by-design refusal as the robot failing. A diagnostic that fires on a
// healthy robot is worse than no diagnostic; it is the same false alarm #14
// already cost three rounds of wrong diagnosis.
//
// This tests the class rather than the counter: for a Q10, the status loop must
// make no request at all, must never accumulate failures, and must state the
// reason once instead of once per poll. And it pins the other half — a Q7 must
// still be polled exactly as before, because Q7 is what runs on the
// maintainer's own three robots.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi(model) {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "q10-status-")),
  });
  api.getProductAttribute = jest.fn(() => model);
  api.describeDevice = jest.fn((duid) => `Saugroboter (${duid})`);
  api.deviceNotify = jest.fn();
  const sendRequest = jest.fn(async () => ({
    // A plausible Q7-shaped answer, so that a Q7 control case has something
    // real to map. A Q10 must never get far enough to receive it.
    dps: { 121: 5, 122: 74 },
    state: 5,
    battery: 74,
  }));
  api.messageQueueHandler = { sendRequest };
  return { api, log, sendRequest };
}

const Q10_MODEL = "roborock.vacuum.ss07";
const Q7_MODEL = "roborock.vacuum.sc05";

describe("a Q10 status poll is not attempted, and not counted as a failure", () => {
  test("no request is sent for a Q10", async () => {
    const { api, sendRequest } = createApi(Q10_MODEL);

    const result = await api.refreshB01Status("duid-q10", { force: true });

    expect(sendRequest).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("forty polls produce no failure count and no warning", async () => {
    const { api, log, sendRequest } = createApi(Q10_MODEL);

    // Well past the tenth attempt, which is where the warning used to land,
    // and past the fortieth so a `% 10` warning cannot simply have been
    // renumbered out of the window.
    for (let index = 0; index < 40; index += 1) {
      await api.refreshB01Status("duid-q10", { force: true });
    }

    expect(sendRequest).not.toHaveBeenCalled();
    expect(api._b01StatusState?.get("duid-q10")?.consecutiveFailures ?? 0).toBe(
      0
    );
    const warnings = log.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings).toEqual([]);
    expect(
      warnings.some((line) => line.includes("B01 status has failed"))
    ).toBe(false);
  });

  test("the reason is stated once per robot, not once per poll", async () => {
    const { api, log } = createApi(Q10_MODEL);

    for (let index = 0; index < 12; index += 1) {
      await api.refreshB01Status("duid-q10", { force: true });
    }

    const notices = log.info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Q10"));
    expect(notices).toHaveLength(1);
    // It has to answer the reader's actual question: why is nothing being
    // polled, and where does the state on the tile come from instead.
    expect(notices[0]).toContain("no reply");
    expect(notices[0]).toContain("home data");
    expect(notices[0]).toContain("#19");
  });

  test("each Q10 robot is announced separately", async () => {
    const { api, log } = createApi(Q10_MODEL);

    await api.refreshB01Status("duid-a", { force: true });
    await api.refreshB01Status("duid-b", { force: true });
    await api.refreshB01Status("duid-a", { force: true });

    const notices = log.info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Q10"));
    expect(notices).toHaveLength(2);
  });

  test("nothing is published to the accessory for a Q10", async () => {
    const { api } = createApi(Q10_MODEL);

    await api.refreshB01Status("duid-q10", { force: true });

    // Publishing a fabricated status is the failure mode this whole dialect
    // split exists to prevent: it would state a robot state nobody measured.
    expect(api.deviceNotify).not.toHaveBeenCalled();
    expect(api.getLastKnownLiveStatus("duid-q10")).toBeNull();
  });
});

describe("a Q7 is still polled exactly as before", () => {
  test("the request is sent and the answer is dispatched", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL);

    const result = await api.refreshB01Status("duid-q7", { force: true });

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith("duid-q7", "get_status", []);
    expect(result).not.toBeNull();
    expect(api.deviceNotify).toHaveBeenCalledWith(
      "CloudMessage",
      expect.objectContaining({ duid: "duid-q7" })
    );
  });

  test("an unrecognised B01 model is still treated as a Q7", async () => {
    // The classifier defaults unknown models to Q7, and this loop must not
    // invent a stricter rule of its own: a model nobody has classified yet
    // keeps the behaviour it had before the split.
    const { api, sendRequest } = createApi("roborock.vacuum.zz99");

    await api.refreshB01Status("duid-unknown", { force: true });

    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  test("a Q7 that really does fail still reports it", async () => {
    // The warning is not being deleted, only kept off a robot that cannot
    // answer by design. A Q7 that stops answering is a real fault.
    const { api, log } = createApi(Q7_MODEL);
    api.messageQueueHandler.sendRequest = jest.fn(async () => {
      throw new Error("cloud timed out");
    });

    for (let index = 0; index < 10; index += 1) {
      const state = api._b01StatusState?.get("duid-q7");
      if (state) {
        state.lastAttemptAt = 0;
      }
      await api.refreshB01Status("duid-q7", { force: true });
    }

    const warnings = log.warn.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some((line) => line.includes("B01 status has failed"))
    ).toBe(true);
  });
});
