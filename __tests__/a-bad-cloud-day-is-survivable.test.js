const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// A Pi reboots after a power cut and the router is not up yet. Roborock's
// cloud is unreachable for a minute.
//
// Before 3.20.0 that was terminal on any install that had logged in once.
// `getUserData` returns a stored session without touching the network, so the
// login retry with backoff is never reached; execution goes to
// `getHomeDetail`, which fails. Both `homedataInterval` and
// `reconnectIntervall` are created AFTER that call, and `initUser` was never
// reached, so there was no MQTT client either. The plugin logged one warning,
// registered nothing, and sat idle until a human restarted Homebridge.
//
// The README's "retries with increasing backoff, up to ten attempts"
// described only the login step, which this path skips.

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
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "bad-cloud-day-")),
  });
  api.startB01StatusLoop = jest.fn();
  return api;
}

const warnings = (api) =>
  api.log.warn.mock.calls.map(([line]) => String(line)).filter(Boolean);

describe("a bad cloud day at startup is survivable", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a failure arms a retry instead of going quiet forever", () => {
    const api = createApi();

    api.scheduleStartServiceRetry(new Error("getaddrinfo EAI_AGAIN"));

    expect(api.startServiceRetryTimer).toBeTruthy();
    expect(
      warnings(api).some(
        (line) =>
          line.includes("EAI_AGAIN") && line.includes("Retrying in 1 minute(s)")
      )
    ).toBe(true);
  });

  test("the retry actually calls startService again", () => {
    jest.useFakeTimers();
    const api = createApi();
    api.startService = jest.fn().mockResolvedValue(undefined);

    api.scheduleStartServiceRetry(new Error("cloud 500"));
    expect(api.startService).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60000);
    expect(api.startService).toHaveBeenCalledTimes(1);
    // And it is called WITHOUT Homebridge's callback: that fired once at the
    // original startup and must not fire again.
    expect(api.startService).toHaveBeenCalledWith();
  });

  test("backoff doubles to a ten-minute ceiling and does not give up", () => {
    const api = createApi();
    const delays = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      api.startServiceRetryTimer = null;
      api.scheduleStartServiceRetry(new Error("still down"));
      delays.push(api.startServiceRetryTimer._idleTimeout);
    }

    expect(delays).toEqual([
      60000, 120000, 240000, 480000, 600000, 600000, 600000, 600000,
    ]);
    // No attempt cap. The device is unattended; giving up means a human has
    // to notice, which is the failure this exists to prevent.
    expect(api.startServiceRetryTimer).toBeTruthy();
  });

  test("only one retry is ever in flight", () => {
    const api = createApi();

    api.scheduleStartServiceRetry(new Error("one"));
    const first = api.startServiceRetryTimer;
    api.scheduleStartServiceRetry(new Error("two"));

    expect(api.startServiceRetryTimer).toBe(first);
    expect(api.startServiceRetryAttempts).toBe(1);
  });

  test("a retry is not armed once the plugin is up", () => {
    const api = createApi();
    api.bInited = true;

    api.scheduleStartServiceRetry(new Error("late failure"));

    expect(api.startServiceRetryTimer).toBeFalsy();
  });

  test("the timer is unref'd, so it can never hold Homebridge open", () => {
    const api = createApi();

    api.scheduleStartServiceRetry(new Error("down"));

    expect(api.startServiceRetryTimer.hasRef()).toBe(false);
  });

  test("shutdown clears it", () => {
    const api = createApi();
    api.scheduleStartServiceRetry(new Error("down"));
    expect(api.startServiceRetryTimer).toBeTruthy();

    api.clearTimersAndIntervals();

    expect(api.startServiceRetryTimer).toBeNull();
  });
});
