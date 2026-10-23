"use strict";

// Logging in the way python-roborock 7.13.0 does, against a fake Roborock
// server that answers the way the cloud has been measured to:
//
// - The user-agreement version is looked up (`api/v3/app/agreement/latest`)
//   rather than sent as the hard-coded 14.0 that went stale in September
//   2026: every login that sent it was refused with 3006 "user agreement
//   version is not up-to-date" (python-roborock PR #960; current versions
//   differ per server and country, e.g. euiot 15.1). The lookup falls back to
//   14.0 only when it fails.
// - Country and phone country code come from `api/v1/getUrlByEmail` on the
//   server the login goes to, as python's _get_iot_login_info does, instead of
//   being guessed from the host name (which made every EU account German).
// - Every login attempt is signed afresh (`api/v3/key/sign`). A failed
//   attempt used to leave its signature cached and every retry reused it.
// - A refusal that asking again cannot change (agreement, wrong credentials,
//   a code-only account) stops with a sentence saying what to do; a sign-in
//   block waits hours, not one minute. With one retry loop for every stage
//   and no attempt cap, retrying those every 10 minutes would only deepen a
//   block (9004 locks sign-in for 7 days).

jest.mock("mqtt");

const mqtt = require("mqtt");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  advanceUntil,
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  lines,
  robot,
  useFakeTimersAroundRealIo,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");
const roborockAuth = require("../roborockLib/lib/roborockAuth");
const { RoborockUiServer } = require("../src/ui/index");

const HOUR = 60 * 60 * 1000;
const PASSWORD = "correct horse";

let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    homeData: homeData({ devices: [robot("duid-1", "Stueetage")] }),
    password: PASSWORD,
    passwordLogin: "supported",
    country: "SE",
    countryCode: "46",
  });
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  cloud.requests.length = 0;
  cloud.config.agreement = { majorVersion: 15, minorVersion: 1 };
  mqtt.connect.mockImplementation(() => fakeMqttClient());
  useFakeTimersAroundRealIo();
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
  jest.useRealTimers();
});

function makeAdapter(options = {}) {
  const api = createAdapterOnFakeCloud(cloud, {
    password: PASSWORD,
    ...options,
  });
  adapters.push(api);
  return api;
}

describe("the plugin's own password login", () => {
  test("sends the agreement version the server names for the account's country", async () => {
    const api = makeAdapter();

    await api.startService();
    await waitFor(() => api.isInited(), "the start");

    const [lookup] = cloud.requestsTo("/api/v3/app/agreement/latest");
    expect(lookup.query).toEqual({ country: "SE" });
    const [login] = cloud.requestsTo("/api/v4/auth/email/login/pwd");
    expect(login.form).toMatchObject({ majorVersion: "15", minorVersion: "1" });
  });

  test("falls back to 14.0 when the server cannot say", async () => {
    cloud.config.agreement = null;
    const api = makeAdapter();

    await api.startService();
    await waitFor(() => api.isInited(), "the start");

    const [login] = cloud.requestsTo("/api/v4/auth/email/login/pwd");
    expect(login.form).toMatchObject({ majorVersion: "14", minorVersion: "0" });
  });

  test("signs every attempt afresh", async () => {
    const api = makeAdapter();
    cloud.script("/api/v4/auth/email/login/pwd", { destroy: true });

    await api.startService();
    expect(api.startServiceRetryTimer).toBeTruthy();
    await advanceUntil(cloud, () => api.isInited(), "the retried start");

    const signs = cloud.requestsTo("/api/v3/key/sign");
    const logins = cloud.requestsTo("/api/v4/auth/email/login/pwd");
    expect(signs).toHaveLength(2);
    expect(logins).toHaveLength(2);
    expect(logins[1].headers["x-mercy-k"]).not.toBe(
      logins[0].headers["x-mercy-k"]
    );
    expect(logins[1].headers["x-mercy-ks"]).toBe(signs[1].query.s);
  });

  test.each([
    [3006, "user agreement version is not up-to-date", /user agreement/i],
    [2031, "need two step validate", /verification code/i],
    [2012, "username or password error", /email or password/i],
  ])(
    "a %s refusal stops with what to do, and is not retried",
    async (code, msg, says) => {
      const api = makeAdapter();
      cloud.script("/api/v4/auth/email/login/pwd", {
        body: { code, msg, data: null },
      });

      await api.startService();
      await jest.advanceTimersByTimeAsync(2 * HOUR);

      expect(lines(api.log.error).join("\n")).toMatch(says);
      expect(lines(api.log.warn).join("\n")).not.toMatch(/temporary/);
      expect(api.startServiceRetryTimer ?? null).toBeNull();
      expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(1);
    }
  );

  test("a sign-in block is waited out in hours, not retried every few minutes", async () => {
    const api = makeAdapter();
    cloud.script("/api/v4/auth/email/login/pwd", {
      body: {
        code: 9004,
        msg: "mqtt message rate limit exceeded, sign in blocked for 7 days",
        data: null,
      },
    });

    await api.startService();
    await jest.advanceTimersByTimeAsync(5 * HOUR);
    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(1);
    expect(lines(api.log.error).join("\n")).toMatch(/blocked/);

    await advanceUntil(cloud, () => api.isInited(), "the later attempt");
    expect(cloud.requestsTo("/api/v4/auth/email/login/pwd")).toHaveLength(2);
  });
});

describe("the settings page's code login", () => {
  function uiServer(storagePath) {
    const handlers = new Map();
    class UiHost {
      constructor() {
        this.homebridgeStoragePath = storagePath;
      }
      onRequest(route, handler) {
        handlers.set(route, handler);
      }
      ready() {}
    }
    new RoborockUiServer(UiHost);
    return handlers;
  }

  test("takes the country from the server and the agreement version for it", async () => {
    jest.useRealTimers();
    const handlers = uiServer(
      require("fs").mkdtempSync(
        require("path").join(require("os").tmpdir(), "ui-")
      )
    );

    const result = await handlers.get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      baseURL: cloud.url,
    });

    expect(result.ok).toBe(true);
    const [login] = cloud.requestsTo("/api/v4/auth/email/login/code");
    // Not the guess from the host name, which for any non-Roborock host is US/1.
    expect(login.form).toMatchObject({
      country: "SE",
      countryCode: "46",
      majorVersion: "15",
      minorVersion: "1",
    });
  });

  test("explains a refusal instead of passing Roborock's code through", async () => {
    jest.useRealTimers();
    const handlers = uiServer(
      require("fs").mkdtempSync(
        require("path").join(require("os").tmpdir(), "ui-")
      )
    );
    cloud.script("/api/v4/auth/email/login/code", {
      body: { code: 3009, msg: "user agreement not accepted", data: null },
    });

    const result = await handlers.get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      baseURL: cloud.url,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /accept the user agreement in the Roborock app/i
    );
  });
});

describe("regions", () => {
  test("the RU server is known", () => {
    expect(roborockAuth.getRegionConfig("https://ruiot.roborock.com")).toEqual({
      country: "RU",
      countryCode: "7",
    });
  });
});
