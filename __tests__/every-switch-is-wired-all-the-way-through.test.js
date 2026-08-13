"use strict";

// A switch action is declared in five places: the key list in types.ts, the
// definition table in action_switch_accessory.ts, the arm in runHomeKitAction,
// the enum in config.schema.json, and the checkbox in the settings page. Adding
// "clean" in 3.7.0 meant touching all five, and the failure mode of missing one
// is silent in the worst way — the box is tickable and the switch never
// appears, or the switch appears and the press does nothing.
//
// So this enumerates the rule rather than the instance: whatever the key list
// says, every other surface has to agree with it.

const fs = require("node:fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const { HOMEKIT_ACTION_KEYS } = require("../src/types");
const {
  ACTION_SWITCH_DEFINITIONS,
  getActionSwitchDefinition,
} = require("../src/action_switch_accessory");

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");
const vacuumSource = read("src", "matter_vacuum_accessory.ts");
const schema = JSON.parse(read("config.schema.json"));
const uiJs = read("homebridge-ui", "public", "index.js");
const uiHtml = read("homebridge-ui", "public", "index.html");
const readme = read("README.md");

describe("every declared action reaches every surface", () => {
  test("the definition table covers exactly the key list", () => {
    expect(ACTION_SWITCH_DEFINITIONS.map((entry) => entry.key)).toEqual([
      ...HOMEKIT_ACTION_KEYS,
    ]);
  });

  for (const key of HOMEKIT_ACTION_KEYS) {
    describe(`"${key}"`, () => {
      test("has a definition with a name and a summary", () => {
        const definition = getActionSwitchDefinition(key);
        expect(definition).toBeDefined();
        expect(definition.nameSuffix.length).toBeGreaterThan(0);
        expect(definition.summary.length).toBeGreaterThan(0);
      });

      test("has an arm in runHomeKitAction", () => {
        // Without it the press is a silent no-op: the switch flips, the log
        // says nothing, and the robot never hears about it.
        const body = vacuumSource.slice(
          vacuumSource.indexOf("async runHomeKitAction(")
        );
        const end = body.indexOf("\n  markRegistered()");
        expect(body.slice(0, end)).toMatch(
          new RegExp(`case "${key}":\\s*\\n\\s*await this\\.`)
        );
      });

      test("is selectable in the config schema", () => {
        const items = schema.schema.properties.homeKitActionSwitches.items;
        expect(items.enum).toContain(key);
        expect(items.oneOf.some((entry) => entry.enum[0] === key)).toBe(true);
      });

      test("has a checkbox on the settings page", () => {
        expect(uiJs).toMatch(new RegExp(`\\b${key}: \\(\\) => elements\\.`));
        expect(uiJs).toMatch(new RegExp(`"${key}"`));
        expect(uiHtml).toMatch(
          new RegExp(`id="homekit-action-${key === "locate" ? "locate" : key}"`)
        );
      });
    });
  }

  test("the settings page's key list is the same list", () => {
    const declared = uiJs.match(/const ACTION_SWITCH_KEYS = \[([^\]]*)\]/);
    expect(declared).not.toBeNull();
    const keys = declared[1]
      .split(",")
      .map((entry) => entry.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(keys).toEqual([...HOMEKIT_ACTION_KEYS]);
  });

  test("the schema offers nothing the plugin cannot do", () => {
    expect(schema.schema.properties.homeKitActionSwitches.items.enum).toEqual([
      ...HOMEKIT_ACTION_KEYS,
    ]);
  });
});

describe("the start switch starts the clean the tile would start", () => {
  test("it routes through the shared startCleaning, not its own command", () => {
    // The whole point of the shared method: the switch gets the clean-mode
    // prep, the acknowledgement wait, the timing line and the room selection.
    expect(vacuumSource).toMatch(
      /case "clean":\s*\n\s*await this\.startCleaning\(HOME_SWITCH_SURFACE\);/
    );
    expect(vacuumSource).toMatch(
      /private async startCleaning\(\s*surface: string = MATTER_SURFACE\s*\)/
    );
  });

  test("both start paths name the surface that asked", () => {
    // "Starting Vicky from Matter." and "Starting Vicky from the Home switch."
    // have to be told apart when a schedule misfires.
    const method = vacuumSource.slice(
      vacuumSource.indexOf("private async startCleaning("),
      vacuumSource.indexOf("private async changeCleanMode(")
    );
    const startLines = method.match(/Starting \$\{name\} from [^`]*/g) || [];
    expect(startLines).toHaveLength(2);
    for (const line of startLines) {
      expect(line).toContain("${surfacePhrase(surface)}");
    }
  });

  test("changeRunMode no longer carries its own copy of the start", () => {
    const method = vacuumSource.slice(
      vacuumSource.indexOf("private async changeRunMode("),
      vacuumSource.indexOf("private async startCleaning(")
    );
    expect(method).toMatch(/await this\.startCleaning\(\);/);
    expect(method).not.toContain("app_start");
    expect(method).not.toContain("app_segment_clean_by_ids");
  });

  test("the README documents that the room selection comes with it", () => {
    expect(readme).toMatch(/Start Cleaning starts the clean the tile would/);
    expect(readme).toMatch(/Vicky Start Cleaning/);
  });
});
