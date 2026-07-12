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
  enableMatterChargingDocked: document.getElementById(
    "enable-matter-charging-docked"
  ),
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

  if (!config) {
    updateAuthStatus(false, false);
  } else {
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
    if (elements.enableMatterChargingDocked) {
      elements.enableMatterChargingDocked.checked = Boolean(
        config.enableMatterChargingDockedStates
      );
    }
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

function getFormValues() {
  return {
    email: getEmail(),
    password: getPassword(),
    baseURL: getBaseUrl(),
    skipDevices: getSkipDevices(),
    debugMode: getDebugMode(),
    enableMatterChargingDockedStates: Boolean(
      elements.enableMatterChargingDocked?.checked
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
  return Math.min(100, Math.max(1, Math.round(value)));
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
  saveCredentials(false)
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

async function saveCredentials(showSuccess = false) {
  const formValues = getFormValues();
  const { email, password } = formValues;
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  const patch = {
    ...formValues,
    enableMatterServiceAreaBeta: undefined,
  };

  if (!password) {
    delete patch.password;
  }

  await updatePluginConfig(patch);

  if (password) {
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
    await updatePluginConfig({
      ...formValues,
      enableMatterServiceAreaBeta: undefined,
      encryptedToken: result.encryptedToken,
    });
    showToast("success", result.message || "Login successful.");
    state.hasEncryptedToken = true;
    state.hasPassword = true;
    setLoggedInState(true, true);
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
    await updatePluginConfig({ encryptedToken: undefined });
    showToast("success", result.message || "Logged out.");
    state.hasEncryptedToken = false;
    setLoggedInState(false, state.hasPassword);
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

  await writeClipboard(buildDiagnosticsReport(diagnostics));
  showToast("success", "Redacted diagnostic report copied.");
}

function buildDiagnosticsReport(result) {
  const hasToken = Boolean(result.hasEncryptedToken || state.hasEncryptedToken);
  const lines = [
    "homebridge-roborock-vacuum2 diagnostic report",
    `generatedAt: ${result.generatedAt || "unknown"}`,
    `pluginVersion: ${result.pluginVersion || "unknown"}`,
    `nodeVersion: ${result.nodeVersion || "unknown"}`,
    `token: ${hasToken ? "present" : "missing"}`,
    `homeData: ${result.hasHomeData ? "present" : "missing"}`,
    `cloudOnlyMode: ${getCloudOnlyMode() ? "enabled" : "disabled"}`,
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

function formatDiagnosticPayload(value) {
  try {
    const text = JSON.stringify(value);
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

function init() {
  loadManagedDevices().catch(() => {});
  if (elements.refreshDevices) {
    elements.refreshDevices.addEventListener("click", () =>
      loadManagedDevices()
    );
  }
  loadConfig().catch(() => {
    showToast("error", "Failed to load current config.");
  });
  elements.saveSettings.addEventListener("click", () => saveCredentials(true));
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
  elements.baseUrl.addEventListener("change", () => saveCredentials(false));
  elements.skipDevices.addEventListener("change", () => {
    saveCredentials(false);
    renderManagedDevices();
    rerenderMatterPairing();
  });
  elements.debugMode.addEventListener("change", () => saveCredentials(false));
  if (elements.enableMatterChargingDocked) {
    elements.enableMatterChargingDocked.addEventListener("change", () =>
      saveCredentials(false)
    );
  }
  if (elements.matterChargedBatteryThreshold) {
    elements.matterChargedBatteryThreshold.addEventListener("change", () =>
      saveCredentials(false)
    );
  }
  elements.preferCloudForMatterCommands.addEventListener("change", () =>
    saveCredentials(false)
  );
  elements.cloudOnlyMode.addEventListener("change", () =>
    saveCredentials(false)
  );
  elements.transientWarningThrottleHours.addEventListener("change", () =>
    saveCredentials(false)
  );
  elements.email.addEventListener("change", () => saveCredentials(false));
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
