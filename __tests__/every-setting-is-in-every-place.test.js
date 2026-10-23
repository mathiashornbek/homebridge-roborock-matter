"use strict";

// A setting lives in four places: config.schema.json (what Homebridge
// accepts), RoborockPlatformConfig in src/types.ts (what the code may read),
// and the settings page — its form, or, for the Matter feature toggles that
// 3.12.0 took off the form on purpose so a save can never turn one off, the
// diagnostic report. The review of 3.39.0 found the dock-phase toggle in the
// schema and read by the code but missing from the types and the report, and
// the schedule and Routine switches missing from the report, so a bug report
// could not show they were on. This pins the rule, not the cases.

const fs = require("fs");
const path = require("path");

const { loadSettingsPage } = require("../test-support/settings-page");

const REPO = path.join(__dirname, "..");
const schema = require("../config.schema.json").schema.properties;
const typesSource = fs.readFileSync(path.join(REPO, "src", "types.ts"), "utf8");
const pageSource = fs.readFileSync(
  path.join(REPO, "homebridge-ui", "public", "index.js"),
  "utf8"
);

// Homebridge's own PlatformConfig field.
const HOMEBRIDGE_KEYS = new Set(["name"]);
// Read only to log that it is ignored (Matter-only edition).
const LEGACY_KEYS = new Set(["enableMatter"]);

function declaredConfigKeys() {
  const body = typesSource.match(
    /export interface RoborockPlatformConfig extends PlatformConfig \{([\s\S]*?)\n\}/
  )[1];
  return [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
}

function keysReadBySrc() {
  const keys = new Set();
  for (const file of fs.readdirSync(path.join(REPO, "src"))) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(REPO, "src", file), "utf8");
    for (const m of source.matchAll(/platformConfig\??\.(\w+)/g)) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

const schemaKeys = Object.keys(schema).filter((k) => !HOMEBRIDGE_KEYS.has(k));

test("every schema setting is declared in the config type, and the other way round", () => {
  expect(declaredConfigKeys().sort()).toEqual([...schemaKeys].sort());
});

test("every setting the code reads is in the schema", () => {
  const unknown = keysReadBySrc().filter(
    (key) => !schemaKeys.includes(key) && !LEGACY_KEYS.has(key)
  );
  expect(unknown).toEqual([]);
});

test("every schema setting is on the settings page, on the form or in the report", () => {
  const missing = schemaKeys.filter(
    (key) =>
      !new RegExp(`\\bconfig\\.${key}\\b|\\b${key}:|"${key}"`).test(pageSource)
  );
  expect(missing).toEqual([]);
});

test("the report says which Apple Home features are on, the dock phases and the schedule and Routine switches included", async () => {
  const page = loadSettingsPage({
    email: "owner@example.com",
    enableMatterDockPhases: false,
    enableHomeKitActionSwitches: true,
    enableHomeKitScheduleSwitches: true,
    enableHomeKitRoutineSwitches: true,
  });
  await page.run("loadConfig()");

  const line = await page.run("describeEnabledMatterFeatures()");

  expect(line).not.toMatch(/dockPhases/);
  expect(line).toMatch(/homeKitScheduleSwitches/);
  expect(line).toMatch(/homeKitRoutineSwitches/);

  const defaults = loadSettingsPage({ email: "owner@example.com" });
  await defaults.run("loadConfig()");
  const defaultLine = await defaults.run("describeEnabledMatterFeatures()");
  expect(defaultLine).toMatch(/dockPhases/);
  expect(defaultLine).not.toMatch(/homeKitScheduleSwitches/);
});
