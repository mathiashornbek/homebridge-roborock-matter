const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// Measured on Mathias' own bridge, 29 Aug 2026 08:04:02, 9h41m after the
// restart that ruled out the boot-time cause:
//
//   [Roborock Vacuum] B01 status for 1. Sal recovered after 1 failed
//   attempt(s) (the attempts themselves are debug-level).
//
// The failure it announces was logged at debug. With debug off — the default,
// and how Mathias runs — the user is told a channel recovered from a problem
// they were never told about. The failure side only speaks every tenth
// attempt; the recovery side spoke at one.
//
// The correct rule is already in this file's own neighbour,
// noteLiveRoomFetchRecovered, whose JSDoc states it: announce the recovery
// exactly when the thing it reports on was itself announced, "so the message
// and the behaviour it reports on cannot drift apart". This suite holds the
// B01 status recovery to the same rule.
//
// Note this is NOT the case __tests__/the-first-b01-poll-waits-for-the-cloud-
// session.test.js already covers. That one removed a specific *cause* of the
// spurious line (a boot poll issued before the cloud session was up). The
// log rule was left as it was, so every other transient failure still
// produces the line — which is what the 08:04 measurement is.

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
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-recovery-")),
  });
  api.vacuums["duid-1"] = {};
  api.getRobotVersion = jest.fn().mockResolvedValue("B01");
  api.setDeviceNotify(jest.fn());
  return api;
}

/** Drive `failures` rejected polls, then one that succeeds. */
async function failThenRecover(api, failures) {
  api.messageQueueHandler = {
    sendRequest: jest.fn().mockRejectedValue(new Error("cloud timeout")),
  };
  for (let i = 0; i < failures; i++) {
    const state = api._b01StatusState?.get("duid-1");
    if (state) {
      state.lastAttemptAt = 0;
    }
    await api.getStatus("duid-1");
  }

  api.messageQueueHandler.sendRequest = jest
    .fn()
    .mockResolvedValue({ status: 4, quantity: 100, fault: 0 });
  const state = api._b01StatusState.get("duid-1");
  if (state) {
    state.lastAttemptAt = 0;
  }
  await api.getStatus("duid-1");
}

const linesOf = (mockFn) =>
  mockFn.mock.calls.map(([line]) => String(line)).filter(Boolean);

const recoveryLines = (api) =>
  linesOf(api.log.info).filter((line) => line.includes("recovered after"));

const failureWarnings = (api) =>
  linesOf(api.log.warn).filter((line) =>
    line.includes("B01 status has failed")
  );

describe("a B01 status recovery line names only a failure the log announced", () => {
  // The measurement itself, stated as an assertion.
  test("a single transient failure that heals is not announced at info", async () => {
    const api = createApi();

    await failThenRecover(api, 1);

    expect(failureWarnings(api)).toEqual([]);
    expect(recoveryLines(api)).toEqual([]);
  });

  // The counterpart: do not over-correct into silence. A streak the user was
  // warned about must still get its closing line, or the log's last word on
  // the channel stays "broken".
  test("a streak that reached the warning still reports its recovery", async () => {
    const api = createApi();

    await failThenRecover(api, 10);

    expect(failureWarnings(api)).toHaveLength(1);
    expect(recoveryLines(api)).toEqual([
      expect.stringContaining("recovered after 10 failed attempt(s)"),
    ]);
  });

  // The class rather than the two cases: across every streak length that
  // spans the threshold, an info recovery line must appear exactly when at
  // least one failure warning did. Written as a predicate so a future change
  // to the warning cadence cannot leave the two sides inconsistent without
  // this failing.
  test.each([1, 2, 5, 9, 10, 11, 15, 20])(
    "after %i failure(s), a recovery line appears iff a failure was warned about",
    async (failures) => {
      const api = createApi();

      await failThenRecover(api, failures);

      const wasAnnounced = failureWarnings(api).length > 0;
      const wasClosed = recoveryLines(api).length > 0;
      expect(wasClosed).toBe(wasAnnounced);
    }
  );

  // Whatever the log does, the counter must still reset — the throttle and
  // the backoff read it, so silencing the line must not silence the state.
  test("the failure counter is cleared on success regardless of the log", async () => {
    const api = createApi();

    await failThenRecover(api, 3);

    expect(api._b01StatusState.get("duid-1").consecutiveFailures).toBe(0);
  });
});
