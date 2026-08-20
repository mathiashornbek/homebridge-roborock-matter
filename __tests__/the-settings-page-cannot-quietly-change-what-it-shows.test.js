"use strict";

// Four defects found in one audit of the settings page, all the same shape:
// the form and the saved config disagreed, and the user was never told.
//
// 1. Every checkbox was initialised inside `loadConfig`'s `else` branch, so a
//    plugin that had never been configured skipped the lot. No box carries a
//    `checked` attribute in the markup, so all nine sat unchecked — and the
//    first keystroke in the email field triggers an auto-save that writes
//    `false` for each. The plugin reads these as `!== false`, so absent means
//    on and `false` means off: a brand-new user silently turned OFF room
//    selection, clean mode, battery and live room tracking. Three of those are
//    re-pair settings, so undoing it costs a removal and re-pair per robot.
//
// 2. `verifyTwoFactorCode` never cleared the password field. The row is only
//    hidden, and a hidden input keeps its value, so the next auto-save of any
//    kind wrote the cleartext account password back into config.json — undoing
//    exactly what the token login had just replaced.
//
// 3. Ticking "add the switches" and pressing Save wrote `homeKitActionSwitches:
//    []`. An empty array is an array, so the plugin's `!Array.isArray` fallback
//    to ["dock"] never fired and nothing was published. The user then went
//    hunting for the QR code the settings page had just told them to scan.
//
// 4. The pairing callout and the per-action boxes had no initial state in the
//    markup, and the function that sets it ran only inside `loadConfig`'s
//    success path. So the loud orange callout painted on every page load and
//    disappeared one round trip later, and stayed up permanently if the config
//    failed to load.
//
// These are source rules rather than DOM tests because that is what this
// suite can run, and because each defect is visible in the source shape.

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

describe("a config that does not exist yet still lands on the schema defaults", () => {
  const loadConfig = functionBody("loadConfig");

  // The Matter feature keys that default ON. It was four; the five that used
  // to default OFF now default ON too, so it is nine, and every one of them is
  // a key the plugin reads as `!== false`.
  const DEFAULT_ON_FEATURE_KEYS = [
    "enableMatterServiceArea",
    "enableLiveRoomTracking",
    "enableMatterCleanMode",
    "enableMatterPowerSource",
    "enableFanPowerCleanModes",
    "enableMatterExtendedOperationalStates",
    "enableMatterChargingDockedStates",
    "enableMatterFaultReporting",
    "enableMatterTankFaultReporting",
  ];

  test("the checkbox initialisation does not sit behind a config check", () => {
    // The tell is `elements.<something>.checked =` appearing inside the
    // `if (!config) { … } else {` arm. It now runs against `config || {}`.
    expect(loadConfig).toMatch(/const loaded = config \|\| \{\};/);
    expect(loadConfig).not.toMatch(/\} else \{[\s\S]*\.checked =/);
  });

  test("the default-on features cannot be written off by a form the user never touched", () => {
    // Defect 1 was that an unchecked box saved `false` for a feature the
    // plugin treats as on-when-absent. The boxes are gone now that all nine
    // default on, which closes the same hole from the other end: the form has
    // no opinion to save. So the rule is that none of these keys may appear in
    // getFormValues at all — one `Boolean(elements.x?.checked)` line reappearing
    // there is the whole defect back, and three of the nine are re-pair
    // settings, so it still costs a re-pair per robot.
    const formValues = functionBody("getFormValues");
    for (const key of DEFAULT_ON_FEATURE_KEYS) {
      expect(formValues).not.toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  test("the default-on features are still read as on-unless-false", () => {
    // `Boolean(config.x)` would turn absent into off. The settings page still
    // reads all nine to report what a robot is actually publishing, and every
    // read must stay `!== false`, matching the plugin and config.schema.json.
    const report = functionBody("describeEnabledMatterFeatures");
    for (const key of DEFAULT_ON_FEATURE_KEYS) {
      expect(report).toMatch(new RegExp(`config\\.${key} !== false`));
    }
  });
});

describe("logging in never leaves the password where a later save can find it", () => {
  test("both login paths clear the field", () => {
    for (const name of ["login", "verifyTwoFactorCode"]) {
      const body = functionBody(name);
      expect(body).toMatch(/elements\.password\.value = ""/);
    }
  });

  test("the token path also drops the remembered password state", () => {
    // Otherwise the pill claims a password fallback that no longer exists.
    expect(functionBody("verifyTwoFactorCode")).toMatch(
      /state\.hasPassword = false/
    );
  });
});

describe("the action switches cannot be saved as an empty selection", () => {
  test("the saved value is never [] while the feature is on", () => {
    const body = functionBody("getSavedActionSwitchSelection");
    expect(body).toMatch(/selection\.length === 0/);
    expect(body).toMatch(/return \["dock"\]/);
  });

  test("getFormValues persists the guarded value, not the raw form", () => {
    expect(functionBody("getFormValues")).toMatch(
      /homeKitActionSwitches: getSavedActionSwitchSelection\(\)/
    );
  });

  test("turning the master on ticks something", () => {
    // Belt and braces at the point of the click, so the user sees which
    // switch they are about to get rather than finding out after a restart.
    const listeners = js.slice(js.indexOf("function init()"));
    expect(listeners).toMatch(/applyActionSwitchSelection\(\["dock"\]\)/);
  });
});

describe("the switch block starts in the state the setting is actually in", () => {
  test("the markup ships closed rather than relying on a callback", () => {
    expect(html).toMatch(
      /id="homekit-action-switch-actions" class="checkbox-group disabled"/
    );
    expect(html).toMatch(
      /id="homekit-switch-pairing" class="pairing-callout hidden"/
    );
    for (const action of ["dock", "pause", "locate"]) {
      expect(html).toMatch(
        new RegExp(`id="homekit-action-${action}" type="checkbox" disabled`)
      );
    }
  });

  test("the state is applied on init, not only after a successful config load", () => {
    const init = functionBody("init");
    expect(init).toMatch(/syncActionSwitchAvailability\(\);/);
  });
});

describe("settings that do nothing without their prerequisite say so", () => {
  test("the three dependent controls have no unmet prerequisite left to gate", () => {
    // Two of the three — suction-level modes and live room tracking — were
    // re-pair settings a user could tick, save, restart, re-pair, and only
    // then find out had never been going to do anything. Their prerequisites
    // now default on and can no longer be switched off from this page, so the
    // controls themselves are gone: a box that cannot exist cannot be ticked
    // dead, which is the same guarantee the greying-out bought.
    expect(html).not.toMatch(/id="enable-fan-power-clean-modes"/);
    expect(html).not.toMatch(/id="enable-live-room-tracking"/);
    expect(js).not.toMatch(/elements\.enableFanPowerCleanModes/);
    expect(js).not.toMatch(/elements\.enableLiveRoomTracking/);

    // The third survives, because a number is a preference rather than a
    // feature. Its prerequisite (Charging/Docked) is permanently met, so it
    // must ship enabled and nothing may disable it again.
    expect(html).toMatch(/id="matter-charged-battery-threshold"/);
    expect(html).not.toMatch(
      /id="matter-charged-battery-threshold"[^>]*disabled/
    );
    expect(js).not.toMatch(/matterChargedBatteryThreshold\.disabled/);

    // And nothing is left greying anything out behind the page's back.
    expect(functionBody("syncFeatureDependencies")).not.toMatch(/\.disabled/);
  });

  test("the gate is re-evaluated when a prerequisite changes", () => {
    const init = functionBody("init");
    expect(init).toMatch(/syncFeatureDependencies\(\)/);
  });
});

describe("a save that fails is not reported as a save that worked", () => {
  test("the buttons show progress and surface the error", () => {
    const body = functionBody("handleSaveClick");
    expect(body).toMatch(/button\.disabled = true/);
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/showToast\("error"/);
    expect(body).toMatch(/finally/);
  });

  test("no click or change listener drops a save promise on the floor", () => {
    // Every auto-save goes through autoSave(), which catches. The two literal
    // saveCredentials(false) call sites left are autoSave's own body and the
    // device-row toggle, which has its own .then/.catch chain.
    const init = js.slice(js.indexOf("function init()"));
    expect(init).not.toMatch(/saveCredentials\(/);
  });
});
