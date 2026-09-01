const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// There are TWO startup retries in this file, and only one of them was ever
// wired to shutdown.
//
// `scheduleStartServiceRetry` (3.20.0) keeps its handle on
// `this.startServiceRetryTimer`, checks `bInited` before it fires, and is
// cleared by `clearTimersAndIntervals`. That one is fine.
//
// The login retry in `startService` is the older one. It kept its handle in a
// local `const`, so `clearTimersAndIntervals` had nothing to clear even in
// principle, and the callback had no `bInited` guard. A login that failed on
// a network error armed a timer for up to 10 minutes; if Homebridge shut the
// adapter down inside that window, the timer still fired into the corpse and
// ran `startService` again — a fresh login, a new MQTT client and a new set
// of intervals on an adapter whose sockets had already been destroyed.
//
// This is also where the suite's `You are trying to require a file after the
// Jest environment has been torn down` came from: `startService` opens with
// `require("./i18n/<lang>/translations.json")`.

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
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "login-retry-")),
  });
  api.config.username = "someone@example.com";
  api.config.password = "irrelevant-for-this-path";
  api.startB01StatusLoop = jest.fn();
  api.rr_mqtt_connector = { disconnect: jest.fn(), isConnected: () => false };
  api.localConnector = {
    destroyAllClients: jest.fn(),
    clearLocalDevicedTimeout: jest.fn(),
  };
  return api;
}

// Drive startService far enough to hit the login failure branch, without
// letting anything past it run.
async function failLogin(
  api,
  message = "getaddrinfo EAI_AGAIN api.roborock.com"
) {
  api.getUserData = jest.fn().mockRejectedValue(new Error(message));
  await api.startService(undefined);
}

describe("the login retry does not outlive shutdown", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a transient login failure arms a retry that shutdown can find", async () => {
    jest.useFakeTimers();
    const api = createApi();

    await failLogin(api);

    // The handle has to live on the instance. A local const is unclearable
    // by construction, which is the whole defect.
    expect(api.loginRetryTimer).toBeTruthy();
  });

  test("stopService cancels a pending login retry", async () => {
    jest.useFakeTimers();
    const api = createApi();

    await failLogin(api);
    expect(api.loginRetryTimer).toBeTruthy();

    await api.stopService();

    expect(api.loginRetryTimer).toBeNull();

    // Ten minutes is the backoff ceiling; nothing may fire in that window.
    const startService = jest.spyOn(api, "startService");
    jest.advanceTimersByTime(10 * 60000);
    expect(startService).not.toHaveBeenCalled();
  });

  test("a retry that is already in flight still refuses to resurrect a shut-down adapter", async () => {
    jest.useFakeTimers();
    const api = createApi();

    await failLogin(api);
    const armed = api.loginRetryTimer;
    expect(armed).toBeTruthy();

    // Simulate the race the clear cannot win: shutdown happens, but the
    // timer had already been scheduled by the event loop. The callback
    // itself must decline.
    api.bInited = false;
    api.stopped = true;
    const startService = jest.spyOn(api, "startService");

    jest.advanceTimersByTime(10 * 60000);

    expect(startService).not.toHaveBeenCalled();
  });

  test("without a shutdown the retry still fires, because that is its job", async () => {
    jest.useFakeTimers();
    const api = createApi();

    await failLogin(api);
    expect(api.loginRetryTimer).toBeTruthy();

    const startService = jest
      .spyOn(api, "startService")
      .mockResolvedValue(undefined);

    jest.advanceTimersByTime(60000);

    expect(startService).toHaveBeenCalledTimes(1);
  });

  test("the retry clears its own handle when it fires, so the next failure can arm again", async () => {
    jest.useFakeTimers();
    const api = createApi();

    await failLogin(api);
    jest.spyOn(api, "startService").mockResolvedValue(undefined);

    jest.advanceTimersByTime(60000);

    expect(api.loginRetryTimer).toBeNull();
  });
});
