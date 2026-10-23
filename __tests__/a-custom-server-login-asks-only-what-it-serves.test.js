"use strict";

// The user-agreement version a login carries is looked up on Roborock's own
// servers (`GET api/v3/app/agreement/latest`, python-roborock 7.13.0
// web_api.py `_get_agreement_version`): they refuse a stale one with 3006.
//
// local_roborock_server serves no such lookup. Its v3 route is not public,
// so it falls under the session-token rule and answers a login's lookup
// with HTTP 401 `{"code":2010}` (or 412 before its cloud import); the only
// agreement handler it has (`/api/v4/app/agreement/latest`) is token-
// protected as well and names the app's documents, not a login version; and
// its code login reads no version at all. So a custom server is not asked:
// the login goes straight out with the fallback version, and a region is
// still asked as before.

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const { RoborockUiServer } = require("../src/ui/index");

let cloud;
beforeAll(async () => {
  cloud = await startFakeRoborockCloud({ email: "homebridge@local" });
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
        path.join(os.tmpdir(), "custom-server-agreement-")
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

test("the fake answers the agreement lookup as local_roborock_server does", async () => {
  const https = require("https");
  const answer = await new Promise((resolve, reject) => {
    https
      .get(`${cloud.url}/api/v3/app/agreement/latest?country=DE`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(body) })
        );
      })
      .on("error", reject);
  });
  expect(answer).toEqual({
    status: 401,
    body: { code: 2010, msg: "invalid_credentials" },
  });
});

test("a login to a custom server sends no agreement lookup and logs in", async () => {
  const result = await uiServer().get("/auth/verify-2fa-code")({
    email: cloud.config.email,
    code: cloud.config.pin,
    serverURL: cloud.url,
  });
  expect(result.ok).toBe(true);
  expect(cloud.requests.map((request) => request.path)).not.toContain(
    "/api/v3/app/agreement/latest"
  );
  const [login] = cloud.requestsTo("/api/v4/auth/email/login/code");
  expect(login.form).toMatchObject({ majorVersion: "14", minorVersion: "0" });
});

test("a login to a region still asks for the version", async () => {
  cloud.config.agreement = { majorVersion: 15, minorVersion: 1 };
  try {
    const result = await uiServer().get("/auth/verify-2fa-code")({
      email: cloud.config.email,
      code: cloud.config.pin,
      baseURL: cloud.url,
    });
    expect(result.ok).toBe(true);
    expect(cloud.requestsTo("/api/v3/app/agreement/latest")).toHaveLength(1);
    const [login] = cloud.requestsTo("/api/v4/auth/email/login/code");
    expect(login.form).toMatchObject({ majorVersion: "15", minorVersion: "1" });
  } finally {
    cloud.config.agreement = null;
  }
});
