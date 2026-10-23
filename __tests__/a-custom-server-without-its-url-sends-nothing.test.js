"use strict";

// "Custom server" chosen on the settings page with the URL field still empty
// (or cleared): Send Email went to the saved Roborock region, which mailed a
// real code and counted it against Roborock's limit, and Verify Code then
// sent the local server's PIN to Roborock as a code — answered with "the
// verification code is wrong or has expired", wrong advice for a PIN. With
// a custom server chosen nothing may go anywhere until its URL is valid; the
// page refuses, and so does the UI server for a request that names a custom
// server without a usable URL.

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const { loadSettingsPage } = require("../test-support/settings-page");
const { RoborockUiServer } = require("../src/ui/index");

async function page(config, request) {
  const loaded = loadSettingsPage(
    { email: "owner@example.com", ...config },
    { request }
  );
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

async function click(loaded, id) {
  loaded.element(id).dispatch("click");
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("the settings page with a custom server chosen", () => {
  test.each([
    ["empty", ""],
    ["not a URL yet", "srv.example.com"],
  ])(
    "with the URL %s, Send Email and Verify Code send nothing and say why",
    async (_label, url) => {
      const calls = [];
      const loaded = await page(
        { baseURL: "https://euiot.roborock.com" },
        async (route, body) => {
          calls.push({ route, body });
          return { ok: false, message: "x" };
        }
      );
      await change(loaded, "base-url", "custom");
      loaded.element("server-url").value = url;
      await click(loaded, "send-2fa");
      loaded.element("two-factor-code").value = "123456";
      await click(loaded, "verify-2fa");

      expect(calls.filter(({ route }) => route.startsWith("/auth/"))).toEqual(
        []
      );
      expect(loaded.homebridge.toasts.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringMatching(/server URL/),
      });
    }
  );

  test("a typed URL, not yet saved, is the one the code goes to", async () => {
    const calls = [];
    const loaded = await page(
      { baseURL: "https://euiot.roborock.com" },
      async (route, body) => {
        calls.push({ route, body });
        return { ok: false, message: "x" };
      }
    );
    await change(loaded, "base-url", "custom");
    loaded.element("server-url").value = "https://srv.example.com:555";
    loaded.element("two-factor-code").value = "123456";
    await click(loaded, "verify-2fa");
    const verify = calls.find(({ route }) => route === "/auth/verify-2fa-code");
    expect(verify.body.serverURL).toBe("https://srv.example.com:555");
  });
});

describe("the UI server", () => {
  let cloud;
  beforeAll(async () => {
    cloud = await startFakeRoborockCloud();
    cloud.trust();
  });
  afterAll(async () => cloud.close());
  beforeEach(() => {
    cloud.requests.length = 0;
  });

  function uiServer() {
    const handlers = new Map();
    class UiHost {
      constructor() {
        this.homebridgeStoragePath = fs.mkdtempSync(
          path.join(os.tmpdir(), "custom-server-no-url-")
        );
      }
      onRequest(route, handler) {
        handlers.set(route, handler);
      }
      ready() {}
    }
    new RoborockUiServer(UiHost);
    return handlers;
  }

  test.each(["/auth/send-2fa-email", "/auth/verify-2fa-code", "/auth/login"])(
    "%s naming a custom server with no URL goes nowhere, not to the region",
    async (route) => {
      const result = await uiServer().get(route)({
        email: cloud.config.email,
        code: cloud.config.pin,
        password: "secret",
        // The saved region is reachable; it must still not be asked.
        baseURL: cloud.url,
        serverURL: "",
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/server URL/);
      expect(cloud.requests).toEqual([]);
    }
  );
});
