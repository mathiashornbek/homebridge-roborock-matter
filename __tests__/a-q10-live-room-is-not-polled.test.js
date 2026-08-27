"use strict";

// The second loop that polls a Q10 for something it cannot answer.
//
// 3.19.0 stopped the dedicated B01 status loop from asking a Q10 (`ss*`) for
// `get_status`, because a fire-and-forget dialect sends no reply and every
// refusal was still being counted as a failure. The live-room loop has the
// same shape and was missed: `refreshB01LiveRoom` sends `get_map_list`, which
// is not in NEUTRAL_RESPONSES and has no Q10 translation, so the send choke
// point refuses it by name and throws. The catch increments
// `consecutiveFailures` and every fifth one logs
// "Live-room map fetch has failed N times in a row" at warn level.
//
// It reaches a Q10 through `refreshLiveRoomForDevice`, which gates only on
// `pv === "B01"` — and `pv === "B01"` is both dialects, which is the whole
// premise of #19. The Matter accessory drives it from
// `driveLiveRoomTracking` whenever the robot is in a cleaning run and
// `enableMatterServiceArea` is not false, and that setting defaults to on.
//
// So it fires precisely while the robot is cleaning — the operation
// niclasreich reported working on his `ss07` (#14, 27 Aug 2026). The first two
// failures come 10 s apart and then back off, putting the first warning in his
// log roughly two and a half minutes into a clean he just confirmed was fine.
// That is a fourth round of chasing our own designed refusal.
//
// This tests the class, not the counter: for a Q10 the live-room loop must
// send nothing, count nothing and say why once. And it pins the other half —
// a Q7 must still be fetched, and a Q7 that genuinely stops answering must
// still raise the warning, because Q7 is what runs on the maintainer's own
// three robots.

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

function createApi(model, sendRequestImpl) {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "q10-liveroom-")),
  });
  api.getProductAttribute = jest.fn(() => model);
  api.getVacuumDeviceInfo = jest.fn((duid, key) =>
    key === "pv" ? "B01" : "serial-1"
  );
  api.describeDevice = jest.fn((duid) => `Saugroboter (${duid})`);
  api.deviceNotify = jest.fn();
  const sendRequest = jest.fn(
    sendRequestImpl ||
      // A map list with no current map: enough for the Q7 control case to
      // reach the wire and return without needing a decodable map payload.
      (async () => [{ mapFlag: 0, name: "Main" }])
  );
  api.messageQueueHandler = { sendRequest };
  return { api, log, sendRequest };
}

/** The throttle counts from the last attempt, so a test that wants N attempts
 * has to clear the stamp between them. */
function allowNextAttempt(api, duid) {
  const liveState = api._b01LiveRoomState?.get(duid);
  if (liveState) {
    liveState.lastAttemptAt = 0;
  }
}

const Q10_MODEL = "roborock.vacuum.ss07";
const Q7_MODEL = "roborock.vacuum.sc05";
const UNKNOWN_B01_MODEL = "roborock.vacuum.sc99";

describe("a Q10 live-room fetch is not attempted, and not counted as a failure", () => {
  test("no request is sent for a Q10", async () => {
    const { api, sendRequest } = createApi(Q10_MODEL);

    const result = await api.refreshB01LiveRoom("duid-q10");

    expect(sendRequest).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("twenty fetches produce no failure count and no warning", async () => {
    const { api, log, sendRequest } = createApi(Q10_MODEL);

    // Well past the fifth attempt, which is where the warning used to land,
    // and past the twentieth so a `% 5` warning cannot simply have been
    // renumbered out of the window.
    for (let index = 0; index < 20; index += 1) {
      allowNextAttempt(api, "duid-q10");
      await api.refreshB01LiveRoom("duid-q10");
    }

    expect(sendRequest).not.toHaveBeenCalled();
    expect(
      api._b01LiveRoomState?.get("duid-q10")?.consecutiveFailures ?? 0
    ).toBe(0);
    const warnings = log.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings).toEqual([]);
    expect(
      warnings.some((line) => line.includes("Live-room map fetch has failed"))
    ).toBe(false);
  });

  test("the reason is stated once per robot, not once per fetch", async () => {
    const { api, log } = createApi(Q10_MODEL);

    for (let index = 0; index < 12; index += 1) {
      allowNextAttempt(api, "duid-q10");
      await api.refreshB01LiveRoom("duid-q10");
    }

    const reasons = log.info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("live-room"));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Q10 dialect");
    expect(reasons[0]).toContain("#19");
  });

  test("each robot gets its own single explanation", async () => {
    const { api, log } = createApi(Q10_MODEL);

    for (const duid of ["duid-a", "duid-b", "duid-a", "duid-b"]) {
      allowNextAttempt(api, duid);
      await api.refreshB01LiveRoom(duid);
    }

    const reasons = log.info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("live-room"));
    expect(reasons).toHaveLength(2);
    expect(reasons.some((line) => line.includes("duid-a"))).toBe(true);
    expect(reasons.some((line) => line.includes("duid-b"))).toBe(true);
  });

  test("a Q10 reports no live room rather than a stale one", async () => {
    const { api } = createApi(Q10_MODEL);

    await api.refreshB01LiveRoom("duid-q10");

    expect(api.getLastKnownLiveRoom?.("duid-q10") ?? null).toBeNull();
  });

  // The other half. Everything below must behave exactly as it did before the
  // gate existed.

  test("a Q7 is still fetched", async () => {
    const { api, sendRequest } = createApi(Q7_MODEL);

    await api.refreshB01LiveRoom("duid-q7");

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0][1]).toBe("get_map_list");
  });

  test("an unknown B01 model is still treated as a Q7 and fetched", async () => {
    const { api, sendRequest } = createApi(UNKNOWN_B01_MODEL);

    await api.refreshB01LiveRoom("duid-unknown");

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0][1]).toBe("get_map_list");
  });

  test("a Q7 that really stops answering still raises the warning", async () => {
    const { api, log } = createApi(Q7_MODEL, async () => {
      throw new Error("cloud request timed out");
    });

    for (let index = 0; index < 5; index += 1) {
      allowNextAttempt(api, "duid-q7");
      await api.refreshB01LiveRoom("duid-q7");
    }

    expect(api._b01LiveRoomState.get("duid-q7").consecutiveFailures).toBe(5);
    const warnings = log.warn.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some((line) => line.includes("Live-room map fetch has failed"))
    ).toBe(true);
  });

  test("a Q10 is skipped through refreshLiveRoomForDevice too", async () => {
    const { api, sendRequest } = createApi(Q10_MODEL);

    const result = await api.refreshLiveRoomForDevice("duid-q10", {
      v1State: 5,
    });

    expect(sendRequest).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
