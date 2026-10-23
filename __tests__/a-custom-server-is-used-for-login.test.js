"use strict";

// Issue #43: log in to a self-hosted Roborock server
// (Python-roborock/local_roborock_server) instead of a Roborock region.
//
// The smallest design that works, the one Home Assistant ships as "Manual":
// one optional setting, the server URL. When set, the login and the account
// API (getUrlByEmail, key/sign, code send, code login, getHomeDetail) go to
// it, the PIN configured on the server is entered as the verification code,
// and everything after the login follows the URLs the login answer carries
// (`rriot.r.a` for the IoT API, `rriot.r.m` for MQTT), exactly as for
// Roborock's own servers. Empty means today's behaviour. The URL must be
// https://host[:port], and certificates are verified as always.
//
// Driven against a fake server built from local_roborock_server's routes and
// answers (test-support/fake-roborock-cloud.js): code send is a no-op that
// says it sent, a wrong email or PIN is HTTP 401 with code 2010, the session
// it issues points r.a at itself and r.m at ssl://<host>:8881.

jest.mock("mqtt");

const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  lines,
  quiet,
  robot,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");
const { createFakeHomebridge } = require("../test-support/fake-homebridge");
const { loadSettingsPage } = require("../test-support/settings-page");
const roborockAuth = require("../roborockLib/lib/roborockAuth");
const { RoborockUiServer } = require("../src/ui/index");
const RoborockPlatform = require("../src/platform").default;

const DUID = "duid-s7maxv";
// A region that must never be contacted: .invalid does not resolve.
const UNUSED_REGION = "https://euiot.roborock.invalid";

let cloud;
const adapters = [];

beforeAll(async () => {
  cloud = await startFakeRoborockCloud({
    email: "homebridge@local",
    pin: "424242",
    homeData: homeData({ devices: [robot(DUID, "S7 MaxV")] }),
  });
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  cloud.requests.length = 0;
  mqtt.connect.mockReset();
  mqtt.connect.mockImplementation(() => fakeMqttClient());
});

afterEach(async () => {
  for (const api of adapters.splice(0)) {
    await api.stopService();
  }
});

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

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "custom-server-"));

describe("the server URL setting", () => {
  test.each([
    [
      "https://api-roborock.example.com:555",
      "https://api-roborock.example.com:555",
    ],
    [
      "  https://api-roborock.example.com/  ",
      "https://api-roborock.example.com",
    ],
    ["https://192.168.1.20:555", "https://192.168.1.20:555"],
  ])("%s is used as %s", (input, expected) => {
    expect(roborockAuth.parseServerURL(input)).toBe(expected);
  });

  test.each([
    ["http://api-roborock.example.com:555", /https:\/\//],
    ["api-roborock.example.com", /not a URL/],
    ["https://api-roborock.example.com/api/v1", /just the server/],
    ["https://api-roborock.example.com?x=1", /just the server/],
    ["https://user:pw@api-roborock.example.com", /user name or password/],
  ])("%s is refused", (input, says) => {
    expect(() => roborockAuth.parseServerURL(input)).toThrow(says);
  });
});

describe("the settings page's login", () => {
  test("verifies the server's certificate: an untrusted one fails the login", async () => {
    // Before trust(): Node's normal certificate checks apply, and there is
    // no setting that turns them off.
    const handlers = uiServer(tempDir());
    const result = await handlers.get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      baseURL: UNUSED_REGION,
      serverURL: cloud.url,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/certificate/i);
    cloud.trust();
  });

  test("goes to the server with the PIN as the code, and never to the region", async () => {
    const handlers = uiServer(tempDir());

    const sent = await handlers.get("/auth/send-2fa-email")({
      email: cloud.config.email,
      baseURL: UNUSED_REGION,
      serverURL: cloud.url,
    });
    const result = await handlers.get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      baseURL: UNUSED_REGION,
      serverURL: cloud.url,
    });

    expect(sent.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.encryptedToken).toEqual(expect.any(String));
    const [login] = cloud.requestsTo("/api/v4/auth/email/login/code");
    expect(login.form).toMatchObject({
      email: cloud.config.email,
      code: cloud.config.pin,
    });
  });

  test("a wrong PIN says so", async () => {
    const handlers = uiServer(tempDir());
    const result = await handlers.get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: "000000",
      serverURL: cloud.url,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/PIN/);
  });

  test("an invalid server URL is refused before anything is sent", async () => {
    const handlers = uiServer(tempDir());
    const result = await handlers.get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      serverURL: `http://${cloud.host}`,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/https:\/\//);
    expect(cloud.requests).toHaveLength(0);
  });
});

describe("the plugin", () => {
  test("logs in to the server and then follows the URLs its answer carries", async () => {
    const storagePath = tempDir();
    const login = await uiServer(storagePath).get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      serverURL: cloud.url,
    });
    expect(login.ok).toBe(true);

    const homebridge = createFakeHomebridge({ storagePath });
    const platform = new RoborockPlatform(
      homebridge.homebridgeLog,
      {
        platform: "RoborockVacuumPlatform",
        email: cloud.config.email,
        baseURL: UNUSED_REGION,
        serverURL: cloud.url,
        encryptedToken: login.encryptedToken,
        cloudOnlyMode: true,
      },
      homebridge.api
    );
    adapters.push(platform.roborockAPI);
    quiet(platform.roborockAPI);
    cloud.requests.length = 0;

    homebridge.emit("didFinishLaunching");
    await waitFor(
      () => homebridge.matter.registered.length === 1,
      "the robot's registration"
    );

    expect(cloud.requestsTo("/api/v1/getHomeDetail")).toHaveLength(1);
    expect(
      cloud.requestsTo(`/v2/user/homes/${cloud.config.homeId}`)
    ).toHaveLength(1);
    // MQTT goes where the server's login answer says, unchanged.
    expect(mqtt.connect.mock.calls[0][0]).toBe("ssl://localhost:8881");
    homebridge.emit("shutdown");
  });

  test("an invalid server URL keeps the plugin idle instead of falling back to Roborock", async () => {
    const api = createAdapterOnFakeCloud(cloud, {
      baseURL: UNUSED_REGION,
      serverURL: `${cloud.url}/api`,
      userData: cloud.issueSession(),
    });
    adapters.push(api);

    await api.startService();

    expect(lines(api.log.error).join("\n")).toMatch(/just the server/);
    expect(api.isInited()).toBe(false);
    expect(api.startServiceRetryTimer ?? null).toBeNull();
    expect(cloud.requests).toHaveLength(0);
  });

  test("with no server URL the region is used, as before", async () => {
    const api = createAdapterOnFakeCloud(cloud, {
      userData: cloud.issueSession(),
    });
    adapters.push(api);
    await api.startService();
    await waitFor(() => api.isInited(), "the start");
    expect(api.loginApi.defaults.baseURL).toBe(cloud.url);
  });
});

describe("the settings page", () => {
  async function page(config) {
    const loaded = loadSettingsPage({ email: cloud.config.email, ...config });
    // init() loads the saved config itself, as Homebridge UI's "ready" does.
    loaded.run("init()");
    await new Promise((resolve) => setImmediate(resolve));
    return loaded;
  }

  async function change(loaded, id, value) {
    const element = loaded.element(id);
    element.value = value;
    element.dispatch("change");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  test("saves the server URL and keeps the region underneath it", async () => {
    const loaded = await page({ baseURL: "https://euiot.roborock.com" });

    await change(loaded, "base-url", "custom");
    expect(loaded.element("server-url-row").classList.contains("hidden")).toBe(
      false
    );
    // Its login is the code login: no password row, the code section shown.
    expect(loaded.element("password-row").classList.contains("hidden")).toBe(
      true
    );
    expect(
      loaded.element("two-factor-section").classList.contains("hidden")
    ).toBe(false);

    await change(loaded, "server-url", "https://api-roborock.example.com:555");
    expect(loaded.savedConfig()).toMatchObject({
      baseURL: "https://euiot.roborock.com",
      serverURL: "https://api-roborock.example.com:555",
    });

    // The report says there is one, not where.
    const report = await loaded.run(
      "buildDiagnosticsReport({ hasHomeData: true, devices: [] })"
    );
    expect(report).toMatch(/^server: custom$/m);
    expect(report).not.toMatch(/api-roborock\.example\.com/);
  });

  test("going back to a region clears the server URL", async () => {
    const loaded = await page({
      baseURL: "https://euiot.roborock.com",
      serverURL: "https://api-roborock.example.com:555",
    });
    expect(loaded.element("base-url").value).toBe("custom");
    expect(loaded.element("server-url").value).toBe(
      "https://api-roborock.example.com:555"
    );

    await change(loaded, "base-url", "https://euiot.roborock.com");

    expect(loaded.savedConfig().serverURL).toBeUndefined();
    expect(loaded.savedConfig().baseURL).toBe("https://euiot.roborock.com");
  });

  test("an invalid server URL is not saved, and the page says why", async () => {
    const loaded = await page({ baseURL: "https://euiot.roborock.com" });
    await change(loaded, "base-url", "custom");
    await change(loaded, "server-url", "http://api-roborock.example.com:555");

    expect(loaded.savedConfig().serverURL).toBeUndefined();
    expect(loaded.homebridge.toasts.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringMatching(/https:\/\//),
    });
  });
});
