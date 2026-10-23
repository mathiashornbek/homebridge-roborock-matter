"use strict";

// When Homebridge restores two cached accessories with one UUID, the platform
// unregisters the first — and used to keep it in its own list, so every later
// lookup by UUID found the unregistered one first and bound its handlers to
// an accessory Homebridge no longer served.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFakeHomebridge } = require("../test-support/fake-homebridge");
const RoborockPlatform = require("../src/platform").default;

test("the unregistered duplicate leaves the platform's list too", () => {
  const homebridge = createFakeHomebridge({
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "duplicate-")),
  });
  const platform = new RoborockPlatform(
    homebridge.homebridgeLog,
    { platform: "RoborockVacuumPlatform", email: "owner@example.com" },
    homebridge.api
  );
  const { hap, PlatformAccessory } = homebridge;
  const uuid = hap.uuid.generate("hap:roborock:action:duid-1:dock");
  const first = new PlatformAccessory("Rocky Return to Dock", uuid);
  const second = new PlatformAccessory("Rocky Return to Dock", uuid);

  platform.configureAccessory(first);
  platform.configureAccessory(second);

  expect(homebridge.api.unregisterPlatformAccessories).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    [first]
  );
  expect(platform.accessories).toEqual([second]);
});
