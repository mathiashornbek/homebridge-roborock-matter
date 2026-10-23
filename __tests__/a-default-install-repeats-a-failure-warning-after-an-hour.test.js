"use strict";

/**
 * The library's throttle for repeated "Failed to execute" warnings moved from
 * 6 hours to 1, next to the hourly transport summary. Under Homebridge it
 * never applied: the platform always passed its own default of 6, and the
 * settings schema said 6 as well. An install that never chose a value now
 * gets the library's hour; a value the user set is kept.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFakeHomebridge } = require("../test-support/fake-homebridge");
const { Roborock } = require("../roborockLib/roborockAPI");
const RoborockPlatform = require("../src/platform").default;
const schema = require("../config.schema.json");

const HOUR = 60 * 60 * 1000;

function platformWith(extra) {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "throttle-"));
  const homebridge = createFakeHomebridge({ storagePath });
  return new RoborockPlatform(
    homebridge.homebridgeLog,
    {
      platform: "RoborockVacuumPlatform",
      email: "a@b.c",
      password: "x",
      ...extra,
    },
    homebridge.api
  );
}

test("a default install repeats a failure warning after one hour, as the library does", () => {
  const library = new Roborock({ log: { debug() {} } });

  expect(platformWith({}).roborockAPI.errorLogThrottleMs).toBe(HOUR);
  expect(library.errorLogThrottleMs).toBe(HOUR);
});

test("the settings schema offers the same hour", () => {
  const field = schema.schema.properties.transientWarningThrottleHours;

  expect(field.default * HOUR).toBe(HOUR);
});

test.each([
  [6, 6 * HOUR],
  ["2", 2 * HOUR],
  [0, 0],
])("a value the user set (%p hours) is kept", (hours, expected) => {
  expect(
    platformWith({ transientWarningThrottleHours: hours }).roborockAPI
      .errorLogThrottleMs
  ).toBe(expected);
});

test.each([[-1], ["soon"], [""]])(
  "a value that is not a number of hours (%p) falls back to the hour",
  (hours) => {
    expect(
      platformWith({ transientWarningThrottleHours: hours }).roborockAPI
        .errorLogThrottleMs
    ).toBe(HOUR);
  }
);
