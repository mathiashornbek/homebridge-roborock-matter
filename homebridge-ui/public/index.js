const elements = {
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  passwordRow: document.getElementById("password-row"),
  baseUrl: document.getElementById("base-url"),
  skipDevices: document.getElementById("skip-devices"),
  devicesList: document.getElementById("devices-list"),
  devicesEmpty: document.getElementById("devices-empty"),
  refreshDevices: document.getElementById("refresh-devices"),
  debugMode: document.getElementById("debug-mode"),
  saveFeatureSettings: document.getElementById("save-feature-settings"),
  enableHomeKitActionSwitches: document.getElementById(
    "enable-homekit-action-switches"
  ),
  homeKitActionSwitchActions: document.getElementById(
    "homekit-action-switch-actions"
  ),
  homeKitSwitchPairing: document.getElementById("homekit-switch-pairing"),
  homeKitActionClean: document.getElementById("homekit-action-clean"),
  homeKitActionDock: document.getElementById("homekit-action-dock"),
  homeKitActionEmpty: document.getElementById("homekit-action-empty"),
  homeKitActionPause: document.getElementById("homekit-action-pause"),
  homeKitActionLocate: document.getElementById("homekit-action-locate"),
  enableHomeKitStateSensors: document.getElementById(
    "enable-homekit-state-sensors"
  ),
  homeKitStateSensorStates: document.getElementById(
    "homekit-state-sensor-states"
  ),
  homeKitStateDocked: document.getElementById("homekit-state-docked"),
  homeKitStateCleaning: document.getElementById("homekit-state-cleaning"),
  homeKitStateWaterTankEmpty: document.getElementById(
    "homekit-state-water-tank-empty"
  ),
  homeKitActionSchedules: document.getElementById("homekit-action-schedules"),
  homeKitActionRoutines: document.getElementById("homekit-action-routines"),
  matterChargedBatteryThreshold: document.getElementById(
    "matter-charged-battery-threshold"
  ),
  advancedSettings: document.getElementById("advanced-settings"),
  preferCloudForMatterCommands: document.getElementById(
    "prefer-cloud-for-matter-commands"
  ),
  cloudOnlyMode: document.getElementById("cloud-only-mode"),
  transientWarningThrottleHours: document.getElementById(
    "transient-warning-throttle-hours"
  ),
  code: document.getElementById("two-factor-code"),
  saveSettings: document.getElementById("save-settings"),
  login: document.getElementById("login"),
  logout: document.getElementById("logout"),
  send2fa: document.getElementById("send-2fa"),
  verify2fa: document.getElementById("verify-2fa"),
  twoFactorSection: document.getElementById("two-factor-section"),
  authStatus: document.getElementById("auth-status"),
  toastContainer: document.getElementById("toast-container"),
  testLocal: document.getElementById("test-local"),
  copyDiagnostics: document.getElementById("copy-diagnostics"),
  refreshDiagnostics: document.getElementById("refresh-diagnostics"),
  refreshMatterPairing: document.getElementById("refresh-matter-pairing"),
  matterPairingSummary: document.getElementById("matter-pairing-summary"),
  matterPairingEmpty: document.getElementById("matter-pairing-empty"),
  matterPairingList: document.getElementById("matter-pairing-list"),
  diagnosticsSummary: document.getElementById("diagnostics-summary"),
  diagnosticsEmpty: document.getElementById("diagnostics-empty"),
  localTestResults: document.getElementById("local-test-results"),
  diagnosticsList: document.getElementById("diagnostics-list"),
};

const state = {
  hasEncryptedToken: false,
  hasPassword: false,
  lastDiagnostics: null,
  lastLocalTest: null,
  diagnosticsRefreshTimer: null,
  diagnosticsAutoRefreshAttempts: 0,
};

const DIAGNOSTICS_AUTO_REFRESH_DELAY_MS = 3000;
const DIAGNOSTICS_AUTO_REFRESH_LIMIT = 2;
const DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS = 6;

// Kept in the same order as HOMEKIT_ACTION_KEYS in src/types.ts, so the form,
// the saved config and the plugin all name these the same way.
const ACTION_SWITCH_KEYS = ["clean", "dock", "empty", "pause", "locate"];
const ACTION_SWITCH_ELEMENTS = {
  clean: () => elements.homeKitActionClean,
  dock: () => elements.homeKitActionDock,
  empty: () => elements.homeKitActionEmpty,
  pause: () => elements.homeKitActionPause,
  locate: () => elements.homeKitActionLocate,
};

// Kept in the same order as HOMEKIT_STATE_SENSOR_KEYS in src/types.ts, for the
// same reason as above.
const STATE_SENSOR_KEYS = ["docked", "cleaning", "waterTankEmpty"];
const STATE_SENSOR_ELEMENTS = {
  docked: () => elements.homeKitStateDocked,
  cleaning: () => elements.homeKitStateCleaning,
  waterTankEmpty: () => elements.homeKitStateWaterTankEmpty,
};

function showToast(type, message) {
  if (
    window.homebridge &&
    window.homebridge.toast &&
    typeof window.homebridge.toast[type] === "function"
  ) {
    window.homebridge.toast[type](message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

async function request(path, body, options = {}) {
  try {
    const requestPromise = window.homebridge.request(path, body);
    if (!options.timeoutMs) {
      return await requestPromise;
    }

    return await Promise.race([
      requestPromise,
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: false,
            message: `Request timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`,
          });
        }, options.timeoutMs);
      }),
    ]);
  } catch (error) {
    return { ok: false, message: error.message || "Request failed." };
  }
}

async function loadConfig() {
  const canLoadConfig =
    window.homebridge &&
    typeof window.homebridge.getPluginConfig === "function";
  const configs = canLoadConfig
    ? await window.homebridge.getPluginConfig()
    : null;
  const config = configs
    ? configs.find((entry) => entry.platform === "RoborockVacuumPlatform")
    : null;

  // A plugin that has never been configured returns no block at all. Falling
  // through to `{}` rather than skipping the whole initialisation is the
  // difference between the four default-on features reading as on and the
  // form saving an explicit `false` for each of them on the user's first
  // keystroke — the plugin treats absent as on and `false` as off, and three
  // of the four are re-pair settings, so that mistake costs a re-pair.
  const loaded = config || {};

  if (!config) {
    updateAuthStatus(false, false);
  }

  {
    const config = loaded;
    if (config.email) {
      elements.email.value = config.email;
    }
    elements.baseUrl.value = normalizeBaseUrl(
      config.baseURL || "https://usiot.roborock.com"
    );
    if (config.skipDevices) {
      elements.skipDevices.value = config.skipDevices;
    }
    elements.debugMode.checked = Boolean(config.debugMode);
    // No Apple Home feature toggles to load any more. 3.12.0 removed the
    // whole section: every Matter feature is on unless config.json explicitly
    // says false, and nothing here reads or writes those keys, so a save can
    // never turn one off by accident.
    if (elements.enableHomeKitActionSwitches) {
      elements.enableHomeKitActionSwitches.checked = Boolean(
        config.enableHomeKitActionSwitches
      );
    }
    if (elements.enableHomeKitStateSensors) {
      elements.enableHomeKitStateSensors.checked = Boolean(
        config.enableHomeKitStateSensors
      );
    }
    applyActionSwitchSelection(readActionSwitchSelection(config));
    applyStateSensorSelection(readStateSensorSelection(config));
    if (elements.homeKitActionSchedules) {
      elements.homeKitActionSchedules.checked = Boolean(
        config.enableHomeKitScheduleSwitches
      );
    }
    if (elements.homeKitActionRoutines) {
      elements.homeKitActionRoutines.checked = Boolean(
        config.enableHomeKitRoutineSwitches
      );
    }
    syncActionSwitchAvailability();
    syncFeatureDependencies();
    if (elements.matterChargedBatteryThreshold) {
      elements.matterChargedBatteryThreshold.value =
        config.matterChargedBatteryThreshold != null
          ? String(config.matterChargedBatteryThreshold)
          : "";
    }
    elements.preferCloudForMatterCommands.checked = Boolean(
      config.preferCloudForMatterCommands
    );
    elements.cloudOnlyMode.checked = Boolean(config.cloudOnlyMode);
    elements.advancedSettings.open = Boolean(
      config.debugMode ||
        config.preferCloudForMatterCommands ||
        config.cloudOnlyMode
    );
    elements.transientWarningThrottleHours.value =
      config.transientWarningThrottleHours ??
      DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;

    state.hasEncryptedToken = Boolean(config.encryptedToken);
    state.hasPassword = Boolean(config.password);
    setLoggedInState(state.hasEncryptedToken, state.hasPassword);
  }

  await loadMatterPairing();

  if (config) {
    await loadDiagnostics({ scheduleFollowUp: true });
  }
}

function getEmail() {
  return elements.email.value.trim();
}

function getPassword() {
  return elements.password.value;
}

function getBaseUrl() {
  return elements.baseUrl.value;
}

function getSkipDevices() {
  return elements.skipDevices.value.trim();
}

function getDebugMode() {
  return Boolean(elements.debugMode.checked);
}

function getPreferCloudForMatterCommands() {
  return Boolean(elements.preferCloudForMatterCommands.checked);
}

function getCloudOnlyMode() {
  return Boolean(elements.cloudOnlyMode.checked);
}

/**
 * The Apple Home features the RUNNING plugin has switched on.
 *
 * This deliberately reads the saved plugin config rather than the checkboxes
 * on screen. A tick that has not been saved and had the bridge restarted is
 * not in effect, and a report that says otherwise sends the reader chasing a
 * behaviour the plugin was never exhibiting — which is exactly what happened
 * when a user toggled a setting, exported a report and we both read it as
 * proof the feature was live.
 *
 * @returns {Promise<string>}
 */
/**
 * The plugin config as SAVED, or null when it cannot be read.
 *
 * Every settings-derived line in the diagnostic report goes through here. The
 * form is only ever consulted afterwards, to warn that it disagrees.
 *
 * @returns {Promise<Record<string, any> | null>}
 */
async function readSavedPluginConfig() {
  try {
    const configs =
      window.homebridge &&
      typeof window.homebridge.getPluginConfig === "function"
        ? await window.homebridge.getPluginConfig()
        : null;
    return configs
      ? configs.find((entry) => entry.platform === "RoborockVacuumPlatform") ||
          null
      : null;
  } catch {
    return null;
  }
}

/**
 * Cloud-only mode as the RUNNING plugin has it.
 *
 * This read the checkbox until 3.4.6, which is the same trap the matterFeatures
 * line was fixed for one line below — fixing the line in front of me instead of
 * the rule. A user who had tried cloud-only mode and switched it off again got
 * a report whose settings line said `disabled` while the device below it said
 * "Cloud only", and spent an evening hunting a ghost setting.
 *
 * @returns {Promise<string>}
 */
async function describeSavedCloudOnlyMode() {
  const config = await readSavedPluginConfig();
  if (!config) {
    return "unavailable";
  }

  const label = config.cloudOnlyMode === true ? "enabled" : "disabled";
  return hasUnsavedCloudOnlyEdit(config)
    ? `${label} (WARNING: the settings form has unsaved changes; this is the value the plugin is running)`
    : label;
}

/** True when the cloud-only checkbox differs from what is saved in the config. */
function hasUnsavedCloudOnlyEdit(config) {
  return (
    Boolean(elements.cloudOnlyMode && elements.cloudOnlyMode.checked) !==
    (config.cloudOnlyMode === true)
  );
}

async function describeEnabledMatterFeatures() {
  const config = await readSavedPluginConfig();

  if (!config) {
    return "unavailable";
  }

  // Every Matter feature is on unless someone has explicitly written false in
  // config.json. The report still lists them, because a support thread needs
  // to know what a robot was actually publishing — and an override that is no
  // longer reachable from the settings page is exactly the thing that would
  // otherwise go unnoticed.
  const enabled = [
    ["serviceArea", config.enableMatterServiceArea !== false],
    ["liveRoomTracking", config.enableLiveRoomTracking !== false],
    ["cleanMode", config.enableMatterCleanMode !== false],
    ["powerSource", config.enableMatterPowerSource !== false],
    ["fanPowerCleanModes", config.enableFanPowerCleanModes !== false],
    [
      "extendedOperationalStates",
      config.enableMatterExtendedOperationalStates !== false,
    ],
    ["chargingDockedStates", config.enableMatterChargingDockedStates !== false],
    ["faultReporting", config.enableMatterFaultReporting !== false],
    ["tankFaultReporting", config.enableMatterTankFaultReporting !== false],
    [
      `homeKitActionSwitches(${readActionSwitchSelection(config).join("+") || "none"})`,
      config.enableHomeKitActionSwitches === true,
    ],
    [
      `homeKitStateSensors(${readStateSensorSelection(config).join("+") || "none"})`,
      config.enableHomeKitStateSensors === true,
    ],
  ]
    .filter(([, on]) => on)
    .map(([name]) => name);

  const saved = enabled.length ? enabled.join(", ") : "none enabled";

  // Unsaved edits are the other half of the same trap.
  return hasUnsavedMatterFeatureEdits(config)
    ? `${saved} (WARNING: the settings form has unsaved changes; these are the values the plugin is running)`
    : saved;
}

/** True when a feature checkbox differs from what is saved in the config. */
function hasUnsavedMatterFeatureEdits(config) {
  const comparisons = [
    [
      elements.enableHomeKitActionSwitches,
      config.enableHomeKitActionSwitches === true,
    ],
    [
      elements.enableHomeKitStateSensors,
      config.enableHomeKitStateSensors === true,
    ],
    [
      elements.homeKitActionSchedules,
      config.enableHomeKitScheduleSwitches === true,
    ],
    [
      elements.homeKitActionRoutines,
      config.enableHomeKitRoutineSwitches === true,
    ],
  ];

  if (
    getActionSwitchSelection().join(",") !==
    readActionSwitchSelection(config).join(",")
  ) {
    return true;
  }

  if (
    getStateSensorSelection().join(",") !==
    readStateSensorSelection(config).join(",")
  ) {
    return true;
  }

  return comparisons.some(
    ([element, savedValue]) =>
      element && Boolean(element.checked) !== savedValue
  );
}

/**
 * The action switches the SAVED config asks for.
 *
 * Reads the config only. The report builder reaches this, and a report that
 * quotes the form describes a plugin that is not running.
 */
function readActionSwitchSelection(config) {
  const saved = config?.homeKitActionSwitches;
  if (!Array.isArray(saved)) {
    // Matches the plugin: master on with no list saved means Return to Dock.
    return config?.enableHomeKitActionSwitches === true ? ["dock"] : [];
  }

  return ACTION_SWITCH_KEYS.filter((key) => saved.includes(key));
}

/**
 * What to persist: never an empty list while the feature is on.
 *
 * `[]` and "absent" mean different things to the plugin — absent falls back to
 * Return to Dock, empty publishes nothing — so the form must not be able to
 * produce the silent-nothing state.
 */
function getSavedActionSwitchSelection() {
  const selection = getActionSwitchSelection();
  if (
    selection.length === 0 &&
    Boolean(elements.enableHomeKitActionSwitches?.checked)
  ) {
    return ["dock"];
  }
  return selection;
}

/** The action switches the form currently shows. */
function getActionSwitchSelection() {
  return ACTION_SWITCH_KEYS.filter((key) =>
    Boolean(ACTION_SWITCH_ELEMENTS[key]()?.checked)
  );
}

function applyActionSwitchSelection(selection) {
  ACTION_SWITCH_KEYS.forEach((key) => {
    const element = ACTION_SWITCH_ELEMENTS[key]();
    if (element) {
      element.checked = selection.includes(key);
    }
  });
}

/**
 * The state sensors the SAVED config asks for.
 *
 * Reads the config only, for the same reason readActionSwitchSelection does:
 * the report builder reaches this, and a report that quotes the form describes
 * a plugin that is not running.
 */
function readStateSensorSelection(config) {
  const saved = config?.homeKitStateSensors;
  if (!Array.isArray(saved)) {
    // Matches the plugin: master on with no list saved means Docked.
    return config?.enableHomeKitStateSensors === true ? ["docked"] : [];
  }

  return STATE_SENSOR_KEYS.filter((key) => saved.includes(key));
}

/**
 * What to persist: never an empty list while the feature is on.
 *
 * `[]` and "absent" mean different things to the plugin — absent falls back to
 * Docked, empty publishes nothing — so the form must not be able to produce the
 * silent-nothing state.
 */
function getSavedStateSensorSelection() {
  const selection = getStateSensorSelection();
  if (
    selection.length === 0 &&
    Boolean(elements.enableHomeKitStateSensors?.checked)
  ) {
    return ["docked"];
  }
  return selection;
}

/** The state sensors the form currently shows. */
function getStateSensorSelection() {
  return STATE_SENSOR_KEYS.filter((key) =>
    Boolean(STATE_SENSOR_ELEMENTS[key]()?.checked)
  );
}

function applyStateSensorSelection(selection) {
  STATE_SENSOR_KEYS.forEach((key) => {
    const element = STATE_SENSOR_ELEMENTS[key]();
    if (element) {
      element.checked = selection.includes(key);
    }
  });
}

/**
 * Kept as a no-op on purpose.
 *
 * It used to grey out settings whose prerequisite was switched off — three of
 * them, two of which were re-pair settings a user could tick, save, restart,
 * re-pair, and only then discover had never been going to do anything. All
 * of those prerequisites are now permanently met, so there is nothing left to
 * grey out. The function stays because several call sites are about the page
 * settling after a load, and deleting it would turn a tidy-up into a hunt.
 */
function syncFeatureDependencies() {}

/** Grey out the per-action and per-state boxes while their feature is off. */
function syncActionSwitchAvailability() {
  const on = Boolean(elements.enableHomeKitActionSwitches?.checked);
  if (elements.homeKitActionSwitchActions) {
    elements.homeKitActionSwitchActions.classList.toggle("disabled", !on);
  }
  const sensorsOn = Boolean(elements.enableHomeKitStateSensors?.checked);
  if (elements.homeKitStateSensorStates) {
    elements.homeKitStateSensorStates.classList.toggle("disabled", !sensorsOn);
  }
  // The pairing steps are noise until a feature is on, and the single most
  // important thing on the page the moment one is. Either feature puts the
  // user in the same situation — HAP accessories on a bridge they may never
  // have paired — so the callout follows both, not just the switches.
  if (elements.homeKitSwitchPairing) {
    elements.homeKitSwitchPairing.classList.toggle("hidden", !on && !sensorsOn);
  }
  ACTION_SWITCH_KEYS.forEach((key) => {
    const element = ACTION_SWITCH_ELEMENTS[key]();
    if (element) {
      element.disabled = !on;
    }
  });
  STATE_SENSOR_KEYS.forEach((key) => {
    const element = STATE_SENSOR_ELEMENTS[key]();
    if (element) {
      element.disabled = !sensorsOn;
    }
  });

  if (elements.homeKitActionSchedules) {
    elements.homeKitActionSchedules.disabled = !on;
  }
  if (elements.homeKitActionRoutines) {
    elements.homeKitActionRoutines.disabled = !on;
  }
}

/**
 * Save, with the button saying so and a failure the user can see.
 *
 * The listeners used to drop the promise on the floor: a rejected save left
 * the button untouched and produced no toast, so the only reading available
 * to the user was that it had worked.
 */
async function handleSaveClick(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await saveCredentials(true);
  } catch (error) {
    showToast("error", error?.message || "Could not save settings.");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/** An auto-save that cannot fail silently, and cannot write the panel below. */
function autoSave() {
  saveCredentials(false, { only: AUTO_SAVED_FIELDS }).catch(() =>
    showToast("error", "Could not save that change.")
  );
}

function getTransientWarningThrottleHours() {
  const value = elements.transientWarningThrottleHours.value.trim();
  if (value === "") {
    return DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;
  }

  return parsed;
}

function getCode() {
  return elements.code.value.trim();
}

/**
 * The keys an implicit save is allowed to write.
 *
 * Every control wired to `autoSave()` lives in the Account panel or the
 * advanced block inside it, and the device rows only ever edit `skipDevices`.
 * The Apple Home checkboxes sit in their own panel with their own Save button
 * and deliberately have no autoSave binding — but the implicit saves spread the
 * WHOLE form, so a change to debug mode, region, email or a device row
 * committed whatever those four Apple Home keys happened to be in the DOM at
 * that moment. Two ways that goes wrong, and the first one cost nine
 * accessories three times in one day:
 *
 *  - a box was unticked and NOT saved, and an unrelated change persisted it.
 *    On 20 Aug `debugMode` went `false` -> `true` and
 *    `enableHomeKitStateSensors` went `true` -> `false` in the SAME write: one
 *    debug-mode toggle, and the untouched checkbox rode along.
 *  - the same in reverse — a stray tick committed without a Save.
 *
 * `updatePluginConfig` is a merge, so leaving a key out of the patch keeps
 * whatever is saved. That is the whole fix: an implicit save writes the fields
 * whose own controls triggered it, and nothing else. The password is off the
 * list for the same reason `login()` deletes it — an email-field blur should
 * not write an account password into config.json in cleartext.
 */
const AUTO_SAVED_FIELDS = [
  "email",
  "baseURL",
  "skipDevices",
  "debugMode",
  "matterChargedBatteryThreshold",
  "preferCloudForMatterCommands",
  "cloudOnlyMode",
  "transientWarningThrottleHours",
];

/** The listed keys only. Absent keys survive, because the save is a merge. */
function pickFields(source, keys) {
  const picked = {};
  for (const key of keys) {
    picked[key] = source[key];
  }
  return picked;
}

function getFormValues() {
  return {
    email: getEmail(),
    password: getPassword(),
    baseURL: getBaseUrl(),
    skipDevices: getSkipDevices(),
    debugMode: getDebugMode(),
    enableHomeKitActionSwitches: Boolean(
      elements.enableHomeKitActionSwitches?.checked
    ),
    homeKitActionSwitches: getSavedActionSwitchSelection(),
    enableHomeKitStateSensors: Boolean(
      elements.enableHomeKitStateSensors?.checked
    ),
    homeKitStateSensors: getSavedStateSensorSelection(),
    enableHomeKitScheduleSwitches: Boolean(
      elements.homeKitActionSchedules?.checked
    ),
    enableHomeKitRoutineSwitches: Boolean(
      elements.homeKitActionRoutines?.checked
    ),
    matterChargedBatteryThreshold: getMatterChargedBatteryThreshold(),
    preferCloudForMatterCommands: getPreferCloudForMatterCommands(),
    cloudOnlyMode: getCloudOnlyMode(),
    transientWarningThrottleHours: getTransientWarningThrottleHours(),
  };
}

function getMatterChargedBatteryThreshold() {
  const raw = elements.matterChargedBatteryThreshold?.value?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const clamped = Math.min(100, Math.max(1, Math.round(value)));
  // Otherwise the box keeps showing the rejected 150 while 100 is saved.
  if (elements.matterChargedBatteryThreshold) {
    elements.matterChargedBatteryThreshold.value = String(clamped);
  }
  return clamped;
}

function getSkipTokenSet() {
  return new Set(
    (elements.skipDevices.value || "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
  );
}

function setSkipTokens(tokens) {
  elements.skipDevices.value = [...tokens].join(", ");
}

let managedDevicesCache = [];

async function loadManagedDevices() {
  try {
    const result = await request("/diagnostics/state", {});
    const devices =
      result && result.ok && Array.isArray(result.devices)
        ? result.devices
        : [];
    managedDevicesCache = devices;
    renderManagedDevices();
  } catch (error) {
    managedDevicesCache = [];
    renderManagedDevices();
  }
}

function renderManagedDevices() {
  const container = elements.devicesList;
  const empty = elements.devicesEmpty;
  if (!container || !empty) {
    return;
  }

  container.textContent = "";
  if (!managedDevicesCache.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const skipTokens = getSkipTokenSet();

  for (const device of managedDevicesCache) {
    const duid = device.duid || "";
    const serial = device.serialNumber || "";
    const skipped =
      (duid && skipTokens.has(duid)) || (serial && skipTokens.has(serial));

    const row = document.createElement("label");
    row.className = "device-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !skipped;
    checkbox.addEventListener("change", () =>
      onManagedDeviceToggle(device, checkbox.checked)
    );

    const text = document.createElement("div");
    text.className = "device-text";
    const title = document.createElement("div");
    title.className = "device-title";
    title.textContent = `${device.name || duid || "Unknown device"} — ${device.resolvedModel || "unknown model"}`;
    const detail = document.createElement("small");
    const onlineText =
      device.online === true
        ? "online"
        : device.online === false
          ? "offline"
          : "status unknown";
    detail.textContent = `${duid}${serial ? ` · SN ${serial}` : ""} · ${onlineText}`;
    text.appendChild(title);
    text.appendChild(detail);

    row.appendChild(checkbox);
    row.appendChild(text);

    if (skipped) {
      const chip = document.createElement("span");
      chip.className = "pill warn";
      chip.textContent = "Disabled";
      row.appendChild(chip);
    }

    container.appendChild(row);
  }
}

function onManagedDeviceToggle(device, managed) {
  const tokens = getSkipTokenSet();
  const duid = device.duid || "";
  const serial = device.serialNumber || "";

  if (managed) {
    if (duid) tokens.delete(duid);
    if (serial) tokens.delete(serial);
  } else if (duid || serial) {
    tokens.add(duid || serial);
    // Avoid double entries when both identifiers were present already.
    if (duid && serial) tokens.delete(serial);
  }

  setSkipTokens(tokens);
  rerenderMatterPairing();
  // A device row edits `skipDevices`. It has no business saving the Apple Home
  // panel on the way past.
  saveCredentials(false, { only: AUTO_SAVED_FIELDS })
    .then(() => {
      showToast(
        "success",
        managed
          ? `${device.name || duid} will be managed after the next bridge restart.`
          : `${device.name || duid} disabled. Restart the Roborock bridge to unpublish it.`
      );
    })
    .catch(() => {
      showToast("error", "Could not save the device selection.");
    });
  renderManagedDevices();
}

/**
 * @param {boolean} showSuccess
 * @param {{only?: string[] | null}} [options] `only` narrows the patch to those
 *   keys — see AUTO_SAVED_FIELDS. Omit it for the explicit Save buttons, which
 *   are the only thing allowed to write the whole form.
 */
async function saveCredentials(showSuccess = false, { only = null } = {}) {
  const formValues = getFormValues();
  const { email, password } = formValues;
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  const patch = only
    ? pickFields(formValues, only)
    : {
        ...formValues,
        enableMatterServiceAreaBeta: undefined,
      };

  if (!password) {
    delete patch.password;
  }

  await updatePluginConfig(patch);

  // Only when this save actually carried it. A narrowed patch never does.
  if (password && !only) {
    state.hasPassword = true;
  }

  if (showSuccess) {
    showToast("success", "Settings saved.");
  }

  updateAuthStatus(state.hasEncryptedToken, state.hasPassword);
}

async function login() {
  const formValues = getFormValues();
  const { email, password, baseURL } = formValues;

  if (!email || !password) {
    showToast("error", "Email and password are required.");
    return;
  }

  const result = await request("/auth/login", { email, password, baseURL });

  if (result.ok) {
    // Drop the password once a token exists — the 2FA path below has always
    // done this, and this path spreading the whole form kept the account
    // password in cleartext in config.json for no benefit. The encrypted
    // token is what the plugin authenticates with from here on, and every
    // later `saveCredentials` (fired by a change to email, region, debug mode,
    // ...) used to write the password back again.
    const patch = {
      ...formValues,
      enableMatterServiceAreaBeta: undefined,
      encryptedToken: result.encryptedToken,
    };
    delete patch.password;

    await updatePluginConfig(patch);
    showToast("success", result.message || "Login successful.");
    state.hasEncryptedToken = true;
    state.hasPassword = false;
    if (elements.password) {
      elements.password.value = "";
    }
    setLoggedInState(true, false);
    return;
  }

  if (result.twoFactorRequired) {
    setTwoFactorVisible(true);
    showToast(
      "warning",
      result.message || "Two-factor authentication required."
    );
    elements.code.focus();
    return;
  }

  showToast("error", result.message || "Login failed.");
}

async function sendTwoFactorEmail() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  const result = await request("/auth/send-2fa-email", { email, baseURL });
  if (result.ok) {
    showToast("success", result.message || "Verification email sent.");
  } else {
    showToast("error", result.message || "Failed to send verification email.");
  }
}

async function verifyTwoFactorCode() {
  const formValues = getFormValues();
  const { email, baseURL } = formValues;
  const code = getCode();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }
  if (!code) {
    showToast("error", "Verification code is required.");
    return;
  }

  const result = await request("/auth/verify-2fa-code", {
    email,
    code,
    baseURL,
  });
  if (result.ok) {
    const patch = {
      ...formValues,
      enableMatterServiceAreaBeta: undefined,
      encryptedToken: result.encryptedToken,
    };
    delete patch.password;

    await updatePluginConfig(patch);
    // Same reason the password path clears it: the row is only hidden, and a
    // hidden input keeps its value. Any later auto-save would then find a
    // populated password in getFormValues() and write it back to config.json
    // in cleartext, undoing the very thing this login just replaced.
    if (elements.password) {
      elements.password.value = "";
    }
    state.hasPassword = false;
    showToast("success", result.message || "Verification successful.");
    state.hasEncryptedToken = true;
    setLoggedInState(true, state.hasPassword);
  } else {
    showToast("error", result.message || "Verification failed.");
  }
}

async function logout() {
  const result = await request("/auth/logout");
  if (result.ok) {
    // Clear the password too, or "Logout" does not log out: platform.ts treats
    // a present password as enough to start, so the next Homebridge restart
    // silently re-authenticated and wrote a fresh token.
    await updatePluginConfig({
      encryptedToken: undefined,
      password: undefined,
    });
    showToast("success", result.message || "Logged out.");
    state.hasEncryptedToken = false;
    state.hasPassword = false;
    if (elements.password) {
      elements.password.value = "";
    }
    setLoggedInState(false, false);
    resetDiagnosticsAutoRefresh();
    renderLocalTestResults(null);
    renderDiagnostics(null);
  } else {
    showToast("error", result.message || "Logout failed.");
  }
}

async function loadDiagnostics({ scheduleFollowUp = false } = {}) {
  const result = await request("/diagnostics/state", {});
  if (!result.ok) {
    renderDiagnostics(null, result.message || "Failed to load diagnostics.");
    return null;
  }

  renderDiagnostics(result);
  if (scheduleFollowUp) {
    maybeScheduleDiagnosticsRefresh(result);
  }

  return result;
}

async function loadMatterPairing() {
  const result = await request("/matter/pairing", {});
  if (!result.ok) {
    renderMatterPairing(
      null,
      result.message || "Failed to load Matter pairing codes."
    );
    return null;
  }

  renderMatterPairing(result);
  return result;
}

let lastMatterPairingResult = null;
let showDisabledPairingEntries = false;

function isPairingEntryForDisabledRobot(entry) {
  const tokens = getSkipTokenSet();
  if (!tokens.size) {
    return false;
  }
  return [entry.matchedDuid, entry.matchedSerial, entry.serialNumber].some(
    (identifier) => identifier && tokens.has(identifier)
  );
}

function rerenderMatterPairing() {
  if (lastMatterPairingResult) {
    renderMatterPairing(lastMatterPairingResult);
  }
}

function renderMatterPairing(result, errorMessage) {
  elements.matterPairingList.innerHTML = "";

  if (errorMessage) {
    elements.matterPairingSummary.textContent = errorMessage;
    elements.matterPairingEmpty.classList.remove("hidden");
    return;
  }

  if (!result || !Array.isArray(result.entries)) {
    elements.matterPairingSummary.textContent =
      "Matter pairing codes are not available yet.";
    elements.matterPairingEmpty.classList.remove("hidden");
    return;
  }

  lastMatterPairingResult = result;

  const allEntries = result.entries;
  const disabledEntries = allEntries.filter((entry) =>
    isPairingEntryForDisabledRobot(entry)
  );
  const activeEntries = allEntries.filter(
    (entry) => !disabledEntries.includes(entry)
  );

  const hiddenNote = disabledEntries.length
    ? ` ${disabledEntries.length} entr${disabledEntries.length === 1 ? "y" : "ies"} for disabled robots ${showDisabledPairingEntries ? "shown below" : "hidden"}.`
    : "";
  elements.matterPairingSummary.textContent = `${activeEntries.length} Matter pairing item(s), last checked ${formatTimestamp(result.generatedAt)}.${hiddenNote}`;

  if (allEntries.length === 0) {
    elements.matterPairingEmpty.classList.remove("hidden");
    return;
  }

  elements.matterPairingEmpty.classList.add("hidden");

  const visibleEntries = showDisabledPairingEntries
    ? [...activeEntries, ...disabledEntries]
    : activeEntries;
  elements.matterPairingList.innerHTML = visibleEntries
    .map((entry) => renderMatterPairingCard(entry))
    .join("");

  if (disabledEntries.length) {
    const note = document.createElement("div");
    note.className = "help";

    const text = document.createElement("span");
    text.textContent = showDisabledPairingEntries
      ? "Pairing records for disabled robots are shown above. They are leftover storage; the accessories are no longer registered. Remove them from Apple Home if they still appear there. "
      : `${disabledEntries.length} pairing record${disabledEntries.length === 1 ? "" : "s"} for disabled robots hidden. The accessories are no longer registered; the records are inert leftovers. `;

    const toggle = document.createElement("a");
    toggle.href = "#";
    toggle.textContent = showDisabledPairingEntries ? "Hide" : "Show anyway";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      showDisabledPairingEntries = !showDisabledPairingEntries;
      rerenderMatterPairing();
    });

    note.appendChild(text);
    note.appendChild(toggle);
    elements.matterPairingList.appendChild(note);
  }
}

function renderMatterPairingCard(entry) {
  const isBridge = entry.kind === "bridge";
  const codeLabel = isBridge ? "Manual pairing code" : "11-digit setup code";
  const rawCodeValue = isBridge
    ? entry.manualPairingCode
    : entry.setupCode || entry.manualPairingCode;
  const rawFormattedCode = entry.manualPairingCode || entry.setupCode;
  const codeValue = rawCodeValue || "n/a";
  const formattedCode = rawFormattedCode || "n/a";
  const hasCodeValue = Boolean(rawCodeValue);
  const hasFormattedCode = Boolean(rawFormattedCode);
  const qrMarkup = entry.qrCodeDataUrl
    ? `<img class="qr-image" src="${escapeHtml(entry.qrCodeDataUrl)}" alt="${escapeHtml(entry.name || "Matter")} QR code" />`
    : `<div class="qr-placeholder">No QR code available</div>`;
  const commissionedText = entry.commissioned ? "Commissioned" : "Not paired";
  const statusClass = entry.commissioned ? "good" : "warn";

  return `
    <article class="pairing-card">
      <div class="device-header">
        <h3>${escapeHtml(entry.name || "Matter accessory")}</h3>
        <span class="pill ${statusClass}">${escapeHtml(commissionedText)}</span>
      </div>
      <p class="connection-hint">${escapeHtml(entry.hint || "Use this Matter pairing information in Apple Home.")}</p>
      <div class="pairing-content">
        <div class="qr-wrap">
          ${qrMarkup}
          <button class="secondary compact" data-copy-value="${escapeHtml(entry.qrCode || "")}" ${entry.qrCode ? "" : "disabled"}>Copy QR Payload</button>
        </div>
        <dl class="pairing-details">
          <div>
            <dt>${escapeHtml(codeLabel)}</dt>
            <dd class="setup-code">${escapeHtml(codeValue)}</dd>
          </div>
          <div>
            <dt>Formatted manual code</dt>
            <dd>${escapeHtml(formattedCode)}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>${escapeHtml(isBridge ? "Roborock child/daughter bridge" : "Roborock vacuum accessory")}</dd>
          </div>
          <div>
            <dt>Serial</dt>
            <dd>${escapeHtml(maskIdentifier(entry.serialNumber))}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>${escapeHtml(entry.updatedAt ? formatTimestamp(entry.updatedAt) : "n/a")}</dd>
          </div>
        </dl>
      </div>
      <div class="pairing-actions">
        <button class="primary compact" data-copy-value="${escapeHtml(hasCodeValue ? codeValue : "")}" ${hasCodeValue ? "" : "disabled"}>Copy ${escapeHtml(codeLabel)}</button>
        <button class="secondary compact" data-copy-value="${escapeHtml(hasFormattedCode ? formattedCode : "")}" ${hasFormattedCode ? "" : "disabled"}>Copy Manual Code</button>
      </div>
    </article>
  `;
}

async function handleMatterPairingClick(event) {
  const button = event.target.closest("[data-copy-value]");
  if (!button) {
    return;
  }

  const value = button.getAttribute("data-copy-value");
  if (!value) {
    showToast("warning", "No pairing value is available to copy.");
    return;
  }

  await writeClipboard(value);
  showToast("success", "Matter pairing value copied.");
}

function maybeScheduleDiagnosticsRefresh(result) {
  if (!shouldAutoRefreshDiagnostics(result)) {
    resetDiagnosticsAutoRefresh();
    return;
  }

  if (
    state.diagnosticsAutoRefreshAttempts >= DIAGNOSTICS_AUTO_REFRESH_LIMIT ||
    state.diagnosticsRefreshTimer
  ) {
    return;
  }

  state.diagnosticsAutoRefreshAttempts += 1;
  state.diagnosticsRefreshTimer = setTimeout(() => {
    state.diagnosticsRefreshTimer = null;
    loadDiagnostics({ scheduleFollowUp: true }).catch(() => {
      showToast("error", "Failed to refresh diagnostics.");
    });
  }, DIAGNOSTICS_AUTO_REFRESH_DELAY_MS);
}

function getConnectionStatus(device) {
  return device.connectionStatus || device.localConnectivityState;
}

function shouldAutoRefreshDiagnostics(result) {
  if (!result || !result.hasHomeData || !Array.isArray(result.devices)) {
    return false;
  }

  return result.devices.some((device) => {
    const status = getConnectionStatus(device);
    return (
      status !== "Local connected" || device.tcpConnectionState !== "connected"
    );
  });
}

function resetDiagnosticsAutoRefresh() {
  if (state.diagnosticsRefreshTimer) {
    clearTimeout(state.diagnosticsRefreshTimer);
    state.diagnosticsRefreshTimer = null;
  }

  state.diagnosticsAutoRefreshAttempts = 0;
}

function renderDiagnostics(result, errorMessage) {
  elements.diagnosticsList.innerHTML = "";
  state.lastDiagnostics = result || null;

  if (errorMessage) {
    elements.diagnosticsSummary.textContent = errorMessage;
    elements.diagnosticsEmpty.classList.remove("hidden");
    return;
  }

  if (!result || !result.hasHomeData) {
    elements.diagnosticsSummary.textContent = "No cached HomeData found yet.";
    elements.diagnosticsEmpty.classList.remove("hidden");
    return;
  }

  const hasToken = Boolean(result.hasEncryptedToken || state.hasEncryptedToken);
  const tokenSummary = hasToken ? "token saved" : "no saved token";
  elements.diagnosticsSummary.textContent = `${result.deviceCount} device(s), ${tokenSummary}, last snapshot ${formatTimestamp(result.generatedAt)}.`;

  if (!result.devices || result.devices.length === 0) {
    elements.diagnosticsEmpty.classList.remove("hidden");
    return;
  }

  elements.diagnosticsEmpty.classList.add("hidden");

  result.devices.forEach((device) => {
    const card = document.createElement("article");
    card.className = "diagnostic-device";
    const localClass = device.connectionHealth || "warn";
    const onlineText =
      device.online === null ? "unknown" : String(device.online);
    card.innerHTML = `
      <div class="device-header">
        <h3>${escapeHtml(device.name || "Unknown device")}</h3>
        <span class="pill ${localClass}">${escapeHtml(getConnectionStatus(device) || "Unknown")}</span>
      </div>
      <p class="connection-hint">${escapeHtml(device.connectionHint || "No additional transport details are available yet.")}</p>
      <dl>
        <div><dt>DUID</dt><dd>${escapeHtml(device.duid || "unknown")}</dd></div>
        <div><dt>Serial Number</dt><dd>${escapeHtml(device.serialNumber || "n/a")}</dd></div>
        <div><dt>Resolved Model</dt><dd>${escapeHtml(device.resolvedModel || "unknown")}</dd></div>
        <div><dt>Device Model</dt><dd>${escapeHtml(device.deviceModel || "n/a")}</dd></div>
        <div><dt>Product Model</dt><dd>${escapeHtml(device.productModel || "n/a")}</dd></div>
        <div><dt>Product ID</dt><dd>${escapeHtml(device.productId == null ? "n/a" : String(device.productId))}</dd></div>
        <div><dt>HomeData Source</dt><dd>${escapeHtml(device.homeDataSource || "unknown")}</dd></div>
        <div><dt>Online</dt><dd>${escapeHtml(onlineText)}</dd></div>
        <div><dt>Local IP</dt><dd>${escapeHtml(device.localIp || "n/a")}</dd></div>
        <div><dt>Discovery</dt><dd>${escapeHtml(device.localDiscoveryState || "n/a")}</dd></div>
        <div><dt>TCP State</dt><dd>${escapeHtml(device.tcpConnectionState || "n/a")}</dd></div>
        <div><dt>Marked Remote</dt><dd>${escapeHtml(device.isRemote === null ? "unknown" : String(device.isRemote))}</dd></div>
        <div><dt>Remote Reason</dt><dd>${escapeHtml(device.remoteReason || "n/a")}</dd></div>
        <div><dt>Last Transport</dt><dd>${escapeHtml(device.lastTransport || "n/a")}</dd></div>
        <div><dt>Last Reason</dt><dd>${escapeHtml(device.lastTransportReason || "n/a")}</dd></div>
        <div><dt>Last Method</dt><dd>${escapeHtml(device.lastCommandMethod || "n/a")}</dd></div>
        <div><dt>Transport Updated</dt><dd>${escapeHtml(device.transportUpdatedAt ? formatTimestamp(device.transportUpdatedAt) : "n/a")}</dd></div>
      </dl>
    `;
    elements.diagnosticsList.appendChild(card);
  });
}

async function testLocalConnections() {
  resetDiagnosticsAutoRefresh();
  elements.testLocal.disabled = true;
  const previousLabel = elements.testLocal.textContent;
  elements.testLocal.textContent = "Testing...";

  try {
    const result = await request(
      "/diagnostics/test-local",
      { cloudOnlyMode: getCloudOnlyMode() },
      { timeoutMs: 15000 }
    );
    if (!result.ok) {
      renderLocalTestResults(null, result.message || "Local test failed.");
      showToast("error", result.message || "Local test failed.");
      return null;
    }

    renderLocalTestResults(result);
    const { failedCount, skippedCount } = (result.devices || []).reduce(
      (counts, device) => {
        if (device.status === "failed") {
          counts.failedCount += 1;
        } else if (device.status === "skipped") {
          counts.skippedCount += 1;
        }
        return counts;
      },
      { failedCount: 0, skippedCount: 0 }
    );
    if (failedCount > 0) {
      showToast("warning", "Local connection test found a TCP problem.");
    } else if (skippedCount > 0) {
      showToast("warning", "Local connection test was skipped for a device.");
    } else {
      showToast("success", "Local connection test passed.");
    }

    return result;
  } finally {
    elements.testLocal.disabled = false;
    elements.testLocal.textContent = previousLabel;
  }
}

function renderLocalTestResults(result, errorMessage) {
  state.lastLocalTest = result || null;
  elements.localTestResults.innerHTML = "";

  if (errorMessage) {
    elements.localTestResults.classList.remove("hidden");
    elements.localTestResults.innerHTML = `
      <article class="local-test-card warn">
        <div class="device-header">
          <h3>Local Connection Test</h3>
          <span class="pill warn">Failed</span>
        </div>
        <p class="connection-hint">${escapeHtml(errorMessage)}</p>
      </article>
    `;
    return;
  }

  if (
    !result ||
    !Array.isArray(result.devices) ||
    result.devices.length === 0
  ) {
    elements.localTestResults.classList.add("hidden");
    return;
  }

  elements.localTestResults.classList.remove("hidden");
  const testedAt = formatTimestamp(result.generatedAt);
  const deviceCards = result.devices
    .map((device) => {
      const health = device.health || "warn";
      const status = device.status || "unknown";
      const latencyText =
        device.latencyMs === null || device.latencyMs === undefined
          ? "n/a"
          : `${device.latencyMs} ms`;
      return `
        <article class="local-test-card ${health}">
          <div class="device-header">
            <h3>${escapeHtml(device.name || "Unknown device")}</h3>
            <span class="pill ${health}">${escapeHtml(status)}</span>
          </div>
          <p class="connection-hint">${escapeHtml(device.message || "No local test details were returned.")}</p>
          <dl>
            <div><dt>Latency</dt><dd>${escapeHtml(latencyText)}</dd></div>
            <div><dt>Local IP</dt><dd>${escapeHtml(device.localIp || "n/a")}</dd></div>
            <div><dt>Port</dt><dd>${escapeHtml(device.port || "n/a")}</dd></div>
            <div><dt>Cached Status</dt><dd>${escapeHtml(device.cachedConnectionStatus || "unknown")}</dd></div>
            <div><dt>Cached TCP State</dt><dd>${escapeHtml(device.cachedTcpState || "n/a")}</dd></div>
            <div><dt>Cached Transport</dt><dd>${escapeHtml(device.cachedLastTransport || "n/a")}</dd></div>
            <div><dt>Cached Reason</dt><dd>${escapeHtml(device.cachedLastReason || "n/a")}</dd></div>
            <div><dt>Test Source</dt><dd>${escapeHtml(device.connectionSource || "n/a")}</dd></div>
            <div><dt>Cloud Fallback Likely</dt><dd>${escapeHtml(String(Boolean(device.cloudFallbackLikely)))}</dd></div>
            <div><dt>Transport Updated</dt><dd>${escapeHtml(device.cachedTransportUpdatedAt ? formatTimestamp(device.cachedTransportUpdatedAt) : "n/a")}</dd></div>
          </dl>
        </article>
      `;
    })
    .join("");

  elements.localTestResults.innerHTML = `
    <div class="local-test-heading">
      <h3>Local Connection Test</h3>
      <span class="muted">Tested ${escapeHtml(testedAt)} in ${escapeHtml(String(result.durationMs ?? "n/a"))} ms.</span>
    </div>
    ${deviceCards}
  `;
}

async function copyDiagnosticsReport() {
  let diagnostics = state.lastDiagnostics;
  if (!diagnostics) {
    diagnostics = await loadDiagnostics();
  }

  if (!diagnostics || !diagnostics.hasHomeData) {
    showToast("warning", "No diagnostics are available to copy yet.");
    return;
  }

  await writeClipboard(await buildDiagnosticsReport(diagnostics));
  showToast("success", "Redacted diagnostic report copied.");
}

async function buildDiagnosticsReport(result) {
  const hasToken = Boolean(result.hasEncryptedToken || state.hasEncryptedToken);
  const lines = [
    "homebridge-roborock-matter diagnostic report",
    `generatedAt: ${result.generatedAt || "unknown"}`,
    `pluginVersion: ${result.pluginVersion || "unknown"}`,
    `nodeVersion: ${result.nodeVersion || "unknown"}`,
    `token: ${hasToken ? "present" : "missing"}`,
    `homeData: ${result.hasHomeData ? "present" : "missing"}`,
    `cloudOnlyMode: ${await describeSavedCloudOnlyMode()}`,
    // Which Apple Home features are switched on decides what the plugin is
    // even allowed to publish, so a report that omits them cannot answer
    // "why doesn't Apple Home show X?" — the first question every one of
    // these reports is sent to answer. Guessing cost a full round-trip with
    // a user who had done the test correctly.
    `matterFeatures: ${await describeEnabledMatterFeatures()}`,
    `deviceCount: ${result.deviceCount ?? "unknown"}`,
    "",
  ];

  (result.devices || []).forEach((device, index) => {
    lines.push(`device ${index + 1}: ${device.name || "Unknown device"}`);
    lines.push(`  duid: ${maskIdentifier(device.duid)}`);
    lines.push(`  serialNumber: ${maskIdentifier(device.serialNumber)}`);
    lines.push(`  resolvedModel: ${device.resolvedModel || "unknown"}`);
    lines.push(`  productId: ${device.productId || "n/a"}`);
    lines.push(
      `  online: ${device.online === null ? "unknown" : String(device.online)}`
    );
    lines.push(`  connectionStatus: ${device.connectionStatus || "unknown"}`);
    lines.push(`  connectionHint: ${device.connectionHint || "n/a"}`);
    lines.push(`  localIp: ${maskLocalIp(device.localIp)}`);
    lines.push(`  discovery: ${device.localDiscoveryState || "n/a"}`);
    lines.push(`  tcpState: ${device.tcpConnectionState || "n/a"}`);
    lines.push(
      `  markedRemote: ${device.isRemote === null ? "unknown" : String(device.isRemote)}`
    );
    lines.push(`  remoteReason: ${device.remoteReason || "n/a"}`);
    lines.push(`  lastTransport: ${device.lastTransport || "n/a"}`);
    lines.push(`  lastReason: ${device.lastTransportReason || "n/a"}`);
    lines.push(`  lastMethod: ${device.lastCommandMethod || "n/a"}`);
    lines.push(`  transportUpdatedAt: ${device.transportUpdatedAt || "n/a"}`);
    lines.push(
      `  roborockDiagnosticUpdatedAt: ${device.roborockDiagnosticUpdatedAt || "n/a"}`
    );
    appendRoborockDiagnosticReport(lines, device);
    lines.push("");
  });

  appendLocalTestReport(lines);

  return lines.join("\n").trim();
}

function appendRoborockDiagnosticReport(lines, device) {
  const entries = [
    ["lastStatus", device.lastStatusDiagnostic],
    ["lastServerTimer", device.lastServerTimerDiagnostic],
    ["lastTimer", device.lastTimerDiagnostic],
    ["lastCloudMessage", device.lastCloudMessageDiagnostic],
    ["lastLocalMessage", device.lastLocalMessageDiagnostic],
  ].filter(([, value]) => value !== null && value !== undefined);

  if (entries.length === 0) {
    return;
  }

  lines.push("  roborockDiagnostics:");
  for (const [label, value] of entries) {
    lines.push(`    ${label}: ${formatDiagnosticPayload(value)}`);
  }
}

// Keys whose values must never leave the machine in a report that users are
// told to paste into a public GitHub issue. A denylist is the wrong shape here
// — this block is raw robot RPC output, so the safe default has to be "redact
// anything that looks identifying". `get_network_info` in particular answers
// with the home Wi-Fi SSID, the access point BSSID and the robot MAC, none of
// which matched the upstream token|key|password filter; a BSSID resolves to a
// street address in public Wi-Fi geolocation databases.
const SENSITIVE_DIAGNOSTIC_KEY_PATTERN =
  /ssid|bssid|\bmac\b|gw|gateway|netmask|token|password|secret|rriot|localkey|local_key|\bkey\b|serial|\bsn\b|uid|email|account|latitude|longitude|\blat\b|\blon\b/i;

/** Recursively redact identifying values while keeping the shape readable. */
function redactDiagnosticValue(value, depth = 0) {
  if (depth > 6) {
    return "[depth-limited]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key)
        ? "[redacted]"
        : redactDiagnosticValue(entry, depth + 1);
    }
    return output;
  }
  return value;
}

function formatDiagnosticPayload(value) {
  try {
    const text = JSON.stringify(redactDiagnosticValue(value));
    const masked = maskLocalIpsInText(text);
    return masked.length > 1500 ? `${masked.slice(0, 1500)}...` : masked;
  } catch {
    return "unavailable";
  }
}

function appendLocalTestReport(lines) {
  const result = state.lastLocalTest;
  if (
    !result ||
    !Array.isArray(result.devices) ||
    result.devices.length === 0
  ) {
    return;
  }

  lines.push("latestLocalConnectionTest:");
  lines.push(`  generatedAt: ${result.generatedAt || "unknown"}`);
  lines.push(`  durationMs: ${result.durationMs ?? "unknown"}`);

  result.devices.forEach((device, index) => {
    lines.push(`  device ${index + 1}: ${device.name || "Unknown device"}`);
    lines.push(`    duid: ${maskIdentifier(device.duid)}`);
    lines.push(`    status: ${device.status || "unknown"}`);
    lines.push(`    message: ${maskLocalIpsInText(device.message || "n/a")}`);
    lines.push(`    latencyMs: ${device.latencyMs ?? "n/a"}`);
    lines.push(`    localIp: ${maskLocalIp(device.localIp)}`);
    lines.push(
      `    cachedStatus: ${device.cachedConnectionStatus || "unknown"}`
    );
    lines.push(`    cachedTcpState: ${device.cachedTcpState || "n/a"}`);
    lines.push(
      `    cachedLastTransport: ${device.cachedLastTransport || "n/a"}`
    );
    lines.push(`    cachedLastReason: ${device.cachedLastReason || "n/a"}`);
    lines.push(
      `    cloudFallbackLikely: ${String(Boolean(device.cloudFallbackLikely))}`
    );
    lines.push(
      `    cachedTransportUpdatedAt: ${device.cachedTransportUpdatedAt || "n/a"}`
    );
  });

  lines.push("");
}

async function writeClipboard(text) {
  if (
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the textarea copy path below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function maskIdentifier(value) {
  if (!value) {
    return "n/a";
  }

  const normalized = String(value);
  if (normalized.length <= 8) {
    return "[redacted]";
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function maskLocalIpsInText(value) {
  return String(value).replace(
    /\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g,
    "$1.x"
  );
}

function maskLocalIp(value) {
  if (!value) {
    return "n/a";
  }

  const normalized = String(value);
  const ipv4Parts = normalized.split(".");
  if (ipv4Parts.length === 4) {
    return `${ipv4Parts.slice(0, 3).join(".")}.x`;
  }

  return "present (redacted)";
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeBaseUrl(value) {
  if (!value) {
    return "https://usiot.roborock.com";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `https://${value.replace(/\/+$/, "")}`;
}

function updateAuthStatus(hasToken, hasPassword = false) {
  elements.authStatus.classList.remove("good", "warn");
  if (hasToken) {
    elements.authStatus.textContent = "Token saved";
    elements.authStatus.classList.add("good");
    return;
  }

  if (hasPassword) {
    elements.authStatus.textContent = "Password fallback";
    elements.authStatus.classList.add("warn");
    return;
  }

  elements.authStatus.textContent = "Login needed";
  elements.authStatus.classList.add("warn");
}

function setTwoFactorVisible(isVisible) {
  elements.twoFactorSection.classList.toggle("hidden", !isVisible);
}

function setLoggedInState(isLoggedIn, hasPassword = false) {
  elements.logout.classList.toggle("hidden", !isLoggedIn);
  elements.login.classList.toggle("hidden", isLoggedIn);
  elements.passwordRow.classList.toggle("hidden", isLoggedIn);
  setTwoFactorVisible(false);
  elements.email.readOnly = isLoggedIn;
  elements.email.parentElement.classList.toggle("readonly", isLoggedIn);
  elements.baseUrl.disabled = isLoggedIn;
  elements.baseUrl.parentElement.classList.toggle("readonly", isLoggedIn);
  updateAuthStatus(isLoggedIn, hasPassword);
}

async function updatePluginConfig(patch) {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    return;
  }

  const configs = await window.homebridge.getPluginConfig();
  let config = configs.find(
    (entry) => entry.platform === "RoborockVacuumPlatform"
  );
  if (!config) {
    config = { platform: "RoborockVacuumPlatform", name: "Roborock Vacuum" };
    configs.push(config);
  }

  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
  });

  await window.homebridge.updatePluginConfig(configs);
  await window.homebridge.savePluginConfig();
}

/**
 * Follow Homebridge's theme, not the operating system's.
 *
 * Homebridge UI reaches into this iframe's document and puts classes on our
 * body: `dark-mode` (plus `config-ui-x-dark-mode-<theme>`) when the user has
 * picked a dark theme, and `config-ui-x-<theme>` when they have picked a light
 * one. It also tries to force the background with
 * `body.style.backgroundColor = "#242424 !important"`, which the CSSOM rejects
 * because a property value may not carry `!important` — so that line does
 * nothing and the class is the only signal there is.
 *
 * The page used to read neither, so it stayed white inside a dark Homebridge.
 *
 * Precedence, and the order matters: Homebridge's own choice wins whenever it
 * has expressed one, because a user who picked light in Homebridge on a dark
 * Mac meant light. Only when no Homebridge class is present at all — the page
 * opened on its own, or before the parent has painted — do we fall back to the
 * OS preference, so the first frame is never the wrong colour.
 */
const DARK_CLASS = "dark-mode";
const HOMEBRIDGE_THEME_CLASS = /^config-ui-x-/;

function homebridgeHasChosenATheme() {
  return Array.from(document.body.classList).some((name) =>
    HOMEBRIDGE_THEME_CLASS.test(name)
  );
}

function prefersDark() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function applyTheme() {
  const dark = document.body.classList.contains(DARK_CLASS)
    ? true
    : homebridgeHasChosenATheme()
      ? false
      : prefersDark();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/**
 * Keep following it after the first paint.
 *
 * The theme can change while this page is open — the switch is in the same UI,
 * one screen away — and the parent applies it by mutating our body's class
 * list rather than reloading us. Without the observer the settings page is the
 * one thing in Homebridge that stays the old colour until it is reopened.
 */
function watchTheme() {
  applyTheme();

  new MutationObserver(applyTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });

  if (typeof window.matchMedia === "function") {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    // Only relevant while Homebridge has not chosen for us; applyTheme decides.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", applyTheme);
    }
  }
}

function init() {
  // Before anything else: a page that is briefly the wrong colour is the first
  // thing the eye catches.
  watchTheme();

  // The markup ships in the off state, but say it once here too: loadConfig()
  // can fail or find no config, and the alternative is a loud orange pairing
  // callout for a feature that is switched off.
  syncActionSwitchAvailability();
  syncFeatureDependencies();
  loadManagedDevices().catch(() => {});
  if (elements.refreshDevices) {
    elements.refreshDevices.addEventListener("click", () =>
      loadManagedDevices()
    );
  }
  loadConfig()
    .then(() => {
      // The device rows read the skip list out of the form, and the form is
      // only populated once the config has loaded. Without this the two
      // requests race and a deliberately skipped robot can render as active.
      renderManagedDevices();
    })
    .catch(() => {
      showToast("error", "Failed to load current config.");
    });
  elements.saveSettings.addEventListener("click", () =>
    handleSaveClick(elements.saveSettings)
  );
  if (elements.saveFeatureSettings) {
    elements.saveFeatureSettings.addEventListener("click", () =>
      handleSaveClick(elements.saveFeatureSettings)
    );
  }
  if (elements.enableHomeKitActionSwitches) {
    elements.enableHomeKitActionSwitches.addEventListener("change", () => {
      // Turning the feature on with nothing ticked would save an empty list,
      // and an empty list is not the same as no list: the plugin falls back to
      // ["dock"] only when the key is absent. The user would enable the
      // feature, save, restart, and find no switch to pair.
      if (
        elements.enableHomeKitActionSwitches.checked &&
        getActionSwitchSelection().length === 0
      ) {
        applyActionSwitchSelection(["dock"]);
      }
      syncActionSwitchAvailability();
    });
  }
  if (elements.enableHomeKitStateSensors) {
    elements.enableHomeKitStateSensors.addEventListener("change", () => {
      // Same trap as the switches: an empty saved list is not the same as no
      // list, and the plugin falls back to ["docked"] only when the key is
      // absent. The user would enable the feature, save, restart, and find no
      // sensor to trigger on.
      if (
        elements.enableHomeKitStateSensors.checked &&
        getStateSensorSelection().length === 0
      ) {
        applyStateSensorSelection(["docked"]);
      }
      syncActionSwitchAvailability();
    });
  }
  elements.login.addEventListener("click", login);
  elements.send2fa.addEventListener("click", sendTwoFactorEmail);
  elements.verify2fa.addEventListener("click", verifyTwoFactorCode);
  elements.logout.addEventListener("click", logout);
  elements.testLocal.addEventListener("click", () => {
    testLocalConnections().catch(() => {
      showToast("error", "Failed to run local connection test.");
    });
  });
  elements.copyDiagnostics.addEventListener("click", () => {
    copyDiagnosticsReport().catch(() => {
      showToast("error", "Failed to copy diagnostics.");
    });
  });
  elements.refreshMatterPairing.addEventListener("click", () => {
    loadMatterPairing().catch(() => {
      showToast("error", "Failed to load Matter pairing codes.");
    });
  });
  elements.matterPairingList.addEventListener("click", (event) => {
    handleMatterPairingClick(event).catch(() => {
      showToast("error", "Failed to copy Matter pairing value.");
    });
  });
  elements.baseUrl.addEventListener("change", () => autoSave());
  elements.skipDevices.addEventListener("change", () => {
    autoSave();
    renderManagedDevices();
    rerenderMatterPairing();
  });
  elements.debugMode.addEventListener("change", () => autoSave());
  if (elements.matterChargedBatteryThreshold) {
    elements.matterChargedBatteryThreshold.addEventListener("change", () =>
      autoSave()
    );
  }
  elements.preferCloudForMatterCommands.addEventListener("change", () =>
    autoSave()
  );
  elements.cloudOnlyMode.addEventListener("change", () => autoSave());
  elements.transientWarningThrottleHours.addEventListener("change", () =>
    autoSave()
  );
  elements.email.addEventListener("change", () => autoSave());
  elements.refreshDiagnostics.addEventListener("click", () => {
    resetDiagnosticsAutoRefresh();
    loadDiagnostics().catch(() => {
      showToast("error", "Failed to load diagnostics.");
    });
  });
}

if (window.homebridge) {
  window.homebridge.addEventListener("ready", () => {
    init();
  });
} else {
  document.addEventListener("DOMContentLoaded", init);
}
