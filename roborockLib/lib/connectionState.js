"use strict";

// How the diagnostic report describes a robot's transport, as pure functions.
//
// This lived inside the TypeScript UI server, where `npm test` cannot reach it:
// the test job runs before any build, so the only thing a test could assert
// about these strings was that they appeared somewhere in the source text. The
// wording here is not decoration — it is what a user acts on when their robot
// will not respond, and getting it wrong costs them an evening. A Q7 owner
// unpaired his robot, uninstalled the plugin, reinstalled it and paired again
// because this report told him a local connection had been attempted and had
// failed (#7). His robot's protocol has no local connection to attempt.
//
// So the decisions live in plain JavaScript, next to the transport layer whose
// vocabulary they share, and the tests exercise them directly.

const { B01_CLOUD_ONLY_REMOTE_REASON } = require("./b01Q7Adapter");

/**
 * Whether this robot's protocol has no LAN control surface at all.
 *
 * Read from the reason the transport layer recorded, not from a model list
 * copied down here: one list that can fall out of step with the transport is
 * exactly how the report came to contradict the plugin's own behaviour.
 *
 * @param {Record<string, any>} transport
 * @returns {boolean}
 */
function isCloudOnlyProtocol(transport) {
  return (transport || {}).remoteReason === B01_CLOUD_ONLY_REMOTE_REASON;
}

/**
 * The connection status, health and explanation shown on a device card.
 *
 * @param {Record<string, any>} device
 * @param {Record<string, any>} transport
 * @param {boolean} hasLocalCredentials
 * @returns {{status: string, health: "good" | "warn", hint: string}}
 */
function describeConnectionState(device, transport, hasLocalCredentials) {
  const safeDevice = device || {};
  const safeTransport = transport || {};
  const tcpState = safeTransport.tcpConnectionState;
  const lastTransportReason =
    safeTransport.lastTransportReason || safeTransport.remoteReason || null;
  const hasLocalIp = Boolean(safeTransport.localIp);

  if (
    lastTransportReason === "cloud-only-mode" ||
    safeTransport.localDiscoveryState === "disabled" ||
    tcpState === "disabled"
  ) {
    return {
      status: "Cloud only",
      health: "good",
      hint: "Cloud-only mode is enabled, so local LAN discovery and local TCP control are disabled for this plugin.",
    };
  }

  if (tcpState === "connected") {
    return {
      status: "Local connected",
      health: "good",
      hint: "The plugin has an active LAN TCP connection to this vacuum.",
    };
  }

  if (safeDevice.online === false || lastTransportReason === "device-offline") {
    return {
      status: "Device offline",
      health: "warn",
      hint: hasLocalCredentials
        ? "Roborock currently reports this vacuum offline. Local credentials are available, but the plugin cannot use them until the vacuum wakes up and rejoins Wi-Fi."
        : "Roborock currently reports this vacuum offline, and no local credentials were found for LAN control.",
    };
  }

  // Ahead of the cloud-fallback branch on purpose: for a B01/Q7 robot the cloud
  // is not what the plugin fell back to, it is the only transport the protocol
  // has. Calling it a fallback — and blaming "LAN TCP was not connected at that
  // moment" — describes a network fault that cannot occur.
  if (isCloudOnlyProtocol(safeTransport)) {
    return {
      status: "Cloud control (this model)",
      health: "good",
      hint: "This model speaks only Roborock's cloud protocol, which has no LAN control surface, so the plugin never opens a local connection to it. A blank local IP, discovery state and TCP state are expected here and are not a fault.",
    };
  }

  if (safeTransport.lastTransport === "cloud") {
    return {
      status: "Cloud fallback",
      health: "warn",
      hint: hasLocalCredentials
        ? "The plugin has local credentials but the last command used Roborock cloud transport, usually because LAN TCP was not connected at that moment."
        : "The last command used Roborock cloud transport because local LAN credentials are not available.",
    };
  }

  if (hasLocalCredentials && hasLocalIp) {
    return {
      status: "Ready for local connection",
      health: "warn",
      hint: "The plugin has local credentials and a discovered IP address, but no active LAN TCP connection is currently cached.",
    };
  }

  if (hasLocalCredentials) {
    return {
      status: "Local credentials available",
      health: "warn",
      hint: "The plugin has the credential needed for LAN control, but it has not discovered or connected to the vacuum locally yet.",
    };
  }

  return {
    status: "Cloud-only fallback likely",
    health: "warn",
    hint: "No local LAN credential was found for this vacuum, so the plugin will likely rely on Roborock cloud transport.",
  };
}

/**
 * Why the LAN probe is not being run, or null when it should run.
 *
 * @param {{cloudOnlyProtocol?: boolean, cloudOnlyMode?: boolean,
 *          hasLocalKey?: boolean, online?: boolean, localIp?: string | null}} state
 * @returns {{message: string, health: "good" | "warn"} | null}
 */
function describeLocalProbeSkip(state) {
  const safeState = state || {};

  // First, because there is nothing to probe and nothing wrong. Falling
  // through to the "no local IP is cached yet" branch would tell the user to
  // wait for a discovery that is never going to happen for this model.
  if (safeState.cloudOnlyProtocol) {
    return {
      message:
        "This model speaks only Roborock's cloud protocol, so there is no LAN endpoint to test. Nothing is wrong and no local connection is expected.",
      health: "good",
    };
  }

  if (safeState.cloudOnlyMode) {
    return {
      message:
        "Use Roborock cloud only is enabled, so local LAN probing is skipped until cloud-only mode is disabled and Homebridge is restarted.",
      health: "warn",
    };
  }

  if (!safeState.hasLocalKey) {
    return {
      message:
        "No local credential is cached for this vacuum, so a LAN control test cannot run yet.",
      health: "warn",
    };
  }

  if (safeState.online === false) {
    return {
      message:
        "Roborock currently reports this vacuum offline. Wake the vacuum or place it on the dock, then test again.",
      health: "warn",
    };
  }

  if (!safeState.localIp) {
    return {
      message:
        "No local IP address is cached yet. Let the plugin complete startup or press Refresh after the vacuum wakes up.",
      health: "warn",
    };
  }

  return null;
}

/**
 * Whether to flag this robot as probably falling back to the cloud.
 *
 * A robot whose protocol has no LAN surface is not "likely" to fall back — it
 * was never anywhere else. Flagging it reads as a warning about a network
 * problem the user does not have and cannot fix.
 *
 * @param {Record<string, any>} device
 * @returns {boolean}
 */
function isCloudFallbackLikely(device) {
  const safeDevice = device || {};

  if (safeDevice.remoteReason === B01_CLOUD_ONLY_REMOTE_REASON) {
    return false;
  }

  return (
    safeDevice.lastTransport === "cloud" ||
    safeDevice.connectionStatus === "Cloud fallback"
  );
}

module.exports = {
  describeConnectionState,
  describeLocalProbeSkip,
  isCloudFallbackLikely,
  isCloudOnlyProtocol,
};
