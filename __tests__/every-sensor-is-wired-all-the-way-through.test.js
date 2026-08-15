"use strict";

// The sibling of every-switch-is-wired-all-the-way-through, for the other kind
// of optional HAP accessory. A state sensor is declared in six places: the key
// list in types.ts, the definition table in state_sensor_accessory.ts, the arm
// in getHomeKitStateSensorValue, the enum in config.schema.json, the key list
// and element map in the settings page's script, and the checkbox in its
// markup.
//
// The switches got this test after "clean" was added in 3.7.0 and the sensors
// did not, which is the usual reason a rule covers one half of a pair. Adding
// "waterTankEmpty" is the second time somebody has walked the same six steps by
// hand, so it is enumerated here instead.
//
// The failure mode is silent in the worst way, and worse here than for a
// switch: a tickable box that publishes no accessory looks identical to a
// robot that simply never reports the condition, and "Water Tank Empty" is a
// sensor whose whole job is to stay Open for weeks at a time.

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const { HOMEKIT_STATE_SENSOR_KEYS } = require("../src/types");
const {
  STATE_SENSOR_DEFINITIONS,
  getStateSensorDefinition,
} = require("../src/state_sensor_accessory");

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");
const vacuumSource = read("src", "matter_vacuum_accessory.ts");
const schema = JSON.parse(read("config.schema.json"));
const uiJs = read("homebridge-ui", "public", "index.js");
const uiHtml = read("homebridge-ui", "public", "index.html");
const readme = read("README.md");

/** The body of getHomeKitStateSensorValue, or "" if it is not there. */
function sensorValueBody() {
  const start = vacuumSource.indexOf("getHomeKitStateSensorValue(");
  if (start === -1) {
    return "";
  }
  const end = vacuumSource.indexOf("\n  }", start);
  return vacuumSource.slice(start, end);
}

describe("every declared sensor reaches every surface", () => {
  test("the definition table covers exactly the key list", () => {
    expect(STATE_SENSOR_DEFINITIONS.map((entry) => entry.key)).toEqual([
      ...HOMEKIT_STATE_SENSOR_KEYS,
    ]);
  });

  test("the settings page's key list is the same list in the same order", () => {
    // Order matters here and nowhere else: the script's list drives the order
    // the checkboxes are read and written in, and a saved config compared
    // against a differently ordered selection reports an unsaved change on
    // every page load.
    const declared = uiJs.match(/const STATE_SENSOR_KEYS = \[([^\]]*)\]/);
    expect(declared).not.toBeNull();
    const keys = declared[1]
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(keys).toEqual([...HOMEKIT_STATE_SENSOR_KEYS]);
  });

  for (const key of HOMEKIT_STATE_SENSOR_KEYS) {
    describe(`"${key}"`, () => {
      test("has a definition with a name, a summary and a resting state", () => {
        const definition = getStateSensorDefinition(key);
        expect(definition).toBeDefined();
        expect(definition.nameSuffix.length).toBeGreaterThan(0);
        expect(definition.summary.length).toBeGreaterThan(0);
        // Not defaulted: a missing resting state used to mean Closed for every
        // sensor, which is only correct for "docked". See the resting-state
        // test in an-empty-water-tank-reaches-the-home-app.
        expect(typeof definition.restingState).toBe("boolean");
      });

      test("has an arm in getHomeKitStateSensorValue", () => {
        // Without it the switch falls to the default branch and returns null
        // forever — the accessory appears in the Home app and never moves,
        // which reads exactly like a condition that never occurred.
        expect(sensorValueBody()).toMatch(new RegExp(`case "${key}":`));
      });

      test("is selectable in the config schema", () => {
        const items = schema.schema.properties.homeKitStateSensors.items;
        expect(items.enum).toContain(key);
        expect(items.oneOf.some((entry) => entry.enum[0] === key)).toBe(true);
      });

      test("has a checkbox the settings page can find", () => {
        // Two halves, and each is useless alone: the element map has to name
        // the key, and the id it reaches for has to exist in the markup.
        const mapped = uiJs.match(
          new RegExp(`\\b${key}: \\(\\) => elements\\.([A-Za-z0-9_]+)`)
        );
        expect(mapped).not.toBeNull();

        const elementId = uiJs.match(
          new RegExp(`${mapped[1]}: document\\.getElementById\\(\\s*"([^"]+)"`)
        );
        expect(elementId).not.toBeNull();
        expect(uiHtml).toContain(`id="${elementId[1]}"`);
      });

      test("is named in the README's settings table", () => {
        // The table is where someone editing config.json by hand finds out the
        // key exists at all; the settings page never shows them the string.
        const row = readme
          .split("\n")
          .find((line) => line.includes("`homeKitStateSensors`"));
        expect(row).toBeDefined();
        expect(row).toContain(`\`${key}\``);
      });
    });
  }
});
