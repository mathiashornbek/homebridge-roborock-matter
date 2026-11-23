"use strict";

const assert = require("node:assert/strict");
const { loadSettingsPage } = require("../test-support/settings-page");
const {
  MqttSessionRecovery,
} = require("../roborockLib/lib/mqttSessionRecovery");

const invalidMinutes = [
  undefined,
  null,
  0,
  -1,
  1.5,
  "45",
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER,
];

test("missing or invalid intervals use 180 minutes in the runtime and settings page", async () => {
  for (const minutes of invalidMinutes) {
    const config = { mqttPreventiveRefreshMinutes: minutes };
    const recovery = new MqttSessionRecovery({ adapter: { config } });
    assert.equal(recovery.snapshot().preventiveRefreshMinutes, 180);

    const page = loadSettingsPage(config);
    await page.run("loadConfig()");
    assert.equal(page.element("mqtt-preventive-refresh-minutes").value, "180");
  }
});

test("saved whole-minute intervals take precedence over the default", async () => {
  for (const minutes of [1, 45, 170, 180, 240]) {
    const config = { mqttPreventiveRefreshMinutes: minutes };
    const recovery = new MqttSessionRecovery({ adapter: { config } });
    assert.equal(recovery.snapshot().preventiveRefreshMinutes, minutes);

    const page = loadSettingsPage(config);
    await page.run("loadConfig()");
    assert.equal(
      page.element("mqtt-preventive-refresh-minutes").value,
      String(minutes)
    );
  }
});

test("the interval is editable only with both recovery options enabled", async () => {
  for (const sessionRecovery of [false, true]) {
    for (const preventiveRefresh of [false, true]) {
      const page = loadSettingsPage({
        enableMqttSessionRecovery: sessionRecovery,
        enableMqttPreventiveRefresh: preventiveRefresh,
        mqttPreventiveRefreshMinutes: 45,
      });
      await page.run("loadConfig()");
      assert.equal(
        page.element("mqtt-preventive-refresh-minutes").disabled,
        !(sessionRecovery && preventiveRefresh)
      );
      assert.equal(page.element("mqtt-preventive-refresh-minutes").value, "45");
    }
  }
});

test("saving the interval preserves unsaved Apple Home feature selections", async () => {
  const page = loadSettingsPage({
    email: "owner@example.com",
    enableMqttSessionRecovery: true,
    enableMqttPreventiveRefresh: true,
    enableHomeKitStateSensors: true,
    mqttPreventiveRefreshMinutes: 240,
  });
  await page.run("loadConfig()");
  page.element("mqtt-preventive-refresh-minutes").value = "170";
  page.element("enable-homekit-state-sensors").checked = false;
  await page.run("saveCredentials(false, { only: AUTO_SAVED_FIELDS })");

  assert.equal(page.savedConfig().mqttPreventiveRefreshMinutes, 170);
  assert.equal(page.savedConfig().enableHomeKitStateSensors, true);
  const reloaded = loadSettingsPage(page.savedConfig());
  await reloaded.run("loadConfig()");
  assert.equal(
    reloaded.element("mqtt-preventive-refresh-minutes").value,
    "170"
  );
});

test("disabling and re-enabling recovery retains the chosen interval", async () => {
  const page = loadSettingsPage({
    email: "owner@example.com",
    enableMqttSessionRecovery: true,
    enableMqttPreventiveRefresh: true,
    mqttPreventiveRefreshMinutes: 45,
  });
  await page.run("loadConfig()");
  page.run("init()");
  page.element("enableMqttSessionRecovery").checked = false;
  page.element("enableMqttSessionRecovery").dispatch("change");
  assert.equal(page.element("mqtt-preventive-refresh-minutes").disabled, true);
  await page.run("saveCredentials(false, { only: AUTO_SAVED_FIELDS })");
  assert.equal(page.savedConfig().mqttPreventiveRefreshMinutes, 45);

  await page.run("loadConfig()");
  page.element("enableMqttSessionRecovery").checked = true;
  page.element("enableMqttSessionRecovery").dispatch("change");
  assert.equal(page.element("mqtt-preventive-refresh-minutes").disabled, false);
  assert.equal(page.element("mqtt-preventive-refresh-minutes").value, "45");
  await page.run("saveCredentials(false, { only: AUTO_SAVED_FIELDS })");
});

test("invalid form entries save and display the default as a number", async () => {
  for (const value of [
    "",
    "0",
    "-2",
    "2.5",
    "not a number",
    "9007199254740991",
  ]) {
    const page = loadSettingsPage({ email: "owner@example.com" });
    await page.run("loadConfig()");
    page.element("mqtt-preventive-refresh-minutes").value = value;
    await page.run("saveCredentials(false, { only: AUTO_SAVED_FIELDS })");
    assert.equal(page.savedConfig().mqttPreventiveRefreshMinutes, 180);
    assert.equal(page.element("mqtt-preventive-refresh-minutes").value, "180");
  }
});
