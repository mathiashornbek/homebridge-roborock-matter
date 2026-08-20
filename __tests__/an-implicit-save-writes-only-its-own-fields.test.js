"use strict";

// `enableHomeKitStateSensors` went from `true` to `false` three times in one
// day, and each time nine HAP accessories were unpublished without anyone
// pressing Save. The mechanism, found by reading the source rather than
// guessing at the timeline: `autoSave()` called `saveCredentials()`, which
// spread the ENTIRE form into the patch.
//
// The Apple Home checkboxes live in their own panel with their own Save button
// and deliberately have no autoSave binding — their change listeners only sync
// availability. So the intended flow is tick-then-Save. But because the
// implicit saves wrote the whole form, a change to debug mode, region, email or
// a device row committed whatever those boxes happened to be in the DOM. The
// config diff over one flip shows the signature exactly: `debugMode` false ->
// true and `enableHomeKitStateSensors` true -> false in the SAME write. One
// debug-mode toggle; the untouched checkbox rode along.
//
// This is a source rule rather than a DOM test because that is what this suite
// can run, and because the defect is a shape: which object reaches
// `updatePluginConfig` from which caller.
//
// Note what this does NOT claim. Nothing in the page unchecks that box on its
// own — `syncFeatureDependencies` is empty and no other code path assigns to
// `.checked` outside `loadConfig`. The bug is not that the box unticks itself;
// it is that an unrelated control persists it.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const UI = path.join(REPO, "homebridge-ui", "public");

const js = fs.readFileSync(path.join(UI, "index.js"), "utf8");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");

/** The body of a top-level `function name(...)`, up to the next one. */
function functionBody(name) {
  const start = js.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = js.slice(start + 1);
  const next = rest.search(/^(?:async )?function \w+\s*\(/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The `const NAME = [ ... ]` array literal, as a list of string entries. */
function stringArrayConst(name) {
  const match = js.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  expect(match).not.toBeNull();
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// The keys that belong to the Apple Home Features panel. Every one of these is
// a published-accessory decision: writing one by accident either unpublishes
// accessories the user is triggering automations on, or publishes accessories
// on a bridge they have never paired.
const APPLE_HOME_PANEL_KEYS = [
  "enableHomeKitActionSwitches",
  "homeKitActionSwitches",
  "enableHomeKitStateSensors",
  "homeKitStateSensors",
];

describe("the implicit saves cannot write the Apple Home panel", () => {
  test("autoSave narrows its patch to the auto-saved fields", () => {
    const autoSaveBody = functionBody("autoSave");
    expect(autoSaveBody).toMatch(/only:\s*AUTO_SAVED_FIELDS/);
  });

  test("the device-row toggle narrows its patch too", () => {
    // It edits skipDevices and nothing else, but it went through the same
    // whole-form save, so disabling a robot could unpublish the sensors.
    const toggleBody = functionBody("onManagedDeviceToggle");
    expect(toggleBody).toMatch(
      /saveCredentials\([\s\S]*?only:\s*AUTO_SAVED_FIELDS/
    );
  });

  test("no Apple Home key is on the auto-saved list", () => {
    const autoSaved = stringArrayConst("AUTO_SAVED_FIELDS");
    expect(autoSaved.length).toBeGreaterThan(0);
    for (const key of APPLE_HOME_PANEL_KEYS) {
      expect(autoSaved).not.toContain(key);
    }
  });

  test("the account password is not on the auto-saved list", () => {
    // `login()` deletes the password from its own patch on purpose. An
    // auto-save that put it back made that deletion pointless, and a blur of
    // the email field wrote the cleartext account password into config.json.
    expect(stringArrayConst("AUTO_SAVED_FIELDS")).not.toContain("password");
  });

  test("a narrowed save does not claim a password was stored", () => {
    // `state.hasPassword` drives the login status text. A narrowed patch never
    // carries the password, so setting the flag would report a stored
    // credential that was never written.
    const body = functionBody("saveCredentials");
    expect(body).toMatch(/if \(password && !only\)/);
  });
});

describe("the auto-saved list matches the controls that trigger it", () => {
  // The rule, not the cases: every control wired to `autoSave()` must have its
  // config key on the list, or that control silently stops saving. This is the
  // half of the fix that a future edit is most likely to get wrong — adding an
  // `addEventListener("change", () => autoSave())` and forgetting the list.
  const CONTROL_TO_KEY = {
    baseUrl: "baseURL",
    skipDevices: "skipDevices",
    debugMode: "debugMode",
    matterChargedBatteryThreshold: "matterChargedBatteryThreshold",
    preferCloudForMatterCommands: "preferCloudForMatterCommands",
    cloudOnlyMode: "cloudOnlyMode",
    transientWarningThrottleHours: "transientWarningThrottleHours",
    email: "email",
  };

  /** Element names whose `change` listener reaches autoSave(). */
  function controlsWiredToAutoSave() {
    const init = js.slice(js.indexOf("function init("));
    const found = new Set();
    const pattern =
      /elements\.(\w+)\.addEventListener\(\s*"change",\s*\(\)\s*=>\s*\{?([\s\S]{0,160}?)(?=\n  elements\.|\n  if \(|\n\}|$)/g;
    for (const match of init.matchAll(pattern)) {
      if (match[2].includes("autoSave()")) {
        found.add(match[1]);
      }
    }
    return found;
  }

  test("every autoSave-wired control has its key on the list", () => {
    const autoSaved = stringArrayConst("AUTO_SAVED_FIELDS");
    const wired = controlsWiredToAutoSave();
    // Guard against the regex quietly matching nothing and the test passing.
    expect(wired.size).toBeGreaterThanOrEqual(6);
    for (const control of wired) {
      const key = CONTROL_TO_KEY[control];
      expect(key).toBeDefined();
      expect(autoSaved).toContain(key);
    }
  });

  test("every listed key is a real key of the form", () => {
    const formValues = functionBody("getFormValues");
    for (const key of stringArrayConst("AUTO_SAVED_FIELDS")) {
      expect(formValues).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });
});

describe("the explicit Save is still allowed to write the whole form", () => {
  test("the Apple Home panel has its own Save button", () => {
    // If this button ever goes away, the narrowed auto-save becomes a trap:
    // the checkboxes would have no way at all to reach config.json.
    expect(html).toMatch(/id="save-feature-settings"/);
  });

  test("both Save buttons go through the un-narrowed save", () => {
    const init = js.slice(js.indexOf("function init("));
    expect(init).toMatch(
      /elements\.saveSettings\.addEventListener[\s\S]{0,120}handleSaveClick/
    );
    expect(init).toMatch(
      /elements\.saveFeatureSettings\.addEventListener[\s\S]{0,120}handleSaveClick/
    );
    // handleSaveClick is the one caller that must NOT narrow.
    const save = functionBody("handleSaveClick");
    expect(save).toMatch(/saveCredentials\(true\)/);
    expect(save).not.toMatch(/AUTO_SAVED_FIELDS/);
  });

  test("the Apple Home keys still reach config.json from the full form", () => {
    const formValues = functionBody("getFormValues");
    for (const key of APPLE_HOME_PANEL_KEYS) {
      expect(formValues).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });
});
