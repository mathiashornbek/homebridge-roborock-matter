"use strict";

// local_roborock_server answers a request it cannot serve before its
// one-time cloud import with HTTP 412
// `{"code":41201,"msg":"cloud_user_data_required"}`
// (https_server/routes/auth/service.py cloud_login_data_required_response).
// That reached the user as the bare "cloud_user_data_required" on the
// settings page, and as raw JSON in the plugin's log. Both now say what to
// do.

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const roborockAuth = require("../roborockLib/lib/roborockAuth");
const { RoborockUiServer } = require("../src/ui/index");

// The server's own answer, as service.py builds it.
const CLOUD_DATA_REQUIRED = {
  status: 412,
  body: {
    code: 41201,
    msg: "cloud_user_data_required",
    data: {
      reason: "cloud_snapshot_missing",
      hint: "Fetch cloud data once via /ui/api/cloud/request-code and /ui/api/cloud/submit-code, then retry login.",
      required_snapshot: "/data/cloud_snapshot.json",
    },
  },
};

let cloud;
beforeAll(async () => {
  cloud = await startFakeRoborockCloud({ email: "homebridge@local" });
  cloud.trust();
});
afterAll(async () => cloud.close());

function uiServer() {
  const handlers = new Map();
  class UiHost {
    constructor() {
      this.homebridgeStoragePath = fs.mkdtempSync(
        path.join(os.tmpdir(), "custom-server-import-")
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

test("the settings page's login says to run the server's cloud import", async () => {
  cloud.script("/api/v4/auth/email/login/code", CLOUD_DATA_REQUIRED);
  const result = await uiServer().get("/auth/verify-2fa-code")({
    email: cloud.config.email,
    code: cloud.config.pin,
    serverURL: cloud.url,
  });
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/cloud import/i);
  expect(result.message).not.toBe("cloud_user_data_required");
});

test("the plugin's home-details read says it too", async () => {
  cloud.script("/api/v1/getHomeDetail", CLOUD_DATA_REQUIRED);
  const loginApi = roborockAuth.createLoginApi({
    baseURL: cloud.url,
    username: cloud.config.email,
    clientID: "client",
    language: "en",
  });
  loginApi.defaults.headers.common.Authorization = cloud.issueSession().token;
  await expect(roborockAuth.getHomeId(loginApi)).rejects.toThrow(
    /cloud import/i
  );
});
