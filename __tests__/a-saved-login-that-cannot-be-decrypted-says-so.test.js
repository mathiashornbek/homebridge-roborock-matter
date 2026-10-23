"use strict";

// The settings page stores the login as a token encrypted with a key kept in
// the Homebridge storage folder (roborock.token.key). When that key is gone —
// storage moved, a Docker volume recreated — the token cannot be decrypted,
// the password was removed from config.json by that very login, and the only
// line the user saw was "Login failed or requires 2FA". Now the plugin says
// what happened and what to do.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFakeHomebridge } = require("../test-support/fake-homebridge");
const { encryptSession } = require("../src/crypto");
const RoborockPlatform = require("../src/platform").default;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "token-key-"));

function platformWith(encryptedToken, storagePath) {
  const homebridge = createFakeHomebridge({ storagePath });
  new RoborockPlatform(
    homebridge.homebridgeLog,
    {
      platform: "RoborockVacuumPlatform",
      email: "owner@example.com",
      encryptedToken,
    },
    homebridge.api
  );
  return homebridge.homebridgeLog;
}

test("a token encrypted with a key this machine does not have is reported", () => {
  const session = { token: "t", rriot: { u: "u", s: "s", h: "h", k: "k" } };
  // Encrypted under one storage folder's key, read under another's.
  const token = encryptSession(session, tempDir());

  const log = platformWith(token, tempDir());

  expect(log.error.mock.calls.flat().join("\n")).toMatch(
    /saved login could not be decrypted[\s\S]*log in again in the plugin settings/
  );
});

test("a token that decrypts says nothing", () => {
  const storagePath = tempDir();
  const token = encryptSession(
    { token: "t", rriot: { u: "u", s: "s", h: "h", k: "k" } },
    storagePath
  );

  const log = platformWith(token, storagePath);

  expect(log.error).not.toHaveBeenCalled();
});
