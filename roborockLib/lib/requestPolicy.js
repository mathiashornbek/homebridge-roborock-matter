"use strict";

const { parseServerURL } = require("./roborockAuth");

// Cadences for successful reads only. Failure backoff, write verification,
// duplicate suppression and connection recovery keep their existing limits.
const DEFAULT_REQUEST_POLICY = Object.freeze({
  localServer: false,
  classicStatusGapMs: 60_000,
  liveMapGapMs: 10_000,
  slowParameterGapMs: 30 * 60_000,
});

const LOCAL_SERVER_REQUEST_POLICY = Object.freeze({
  localServer: true,
  classicStatusGapMs: 15_000,
  liveMapGapMs: 3_000,
  slowParameterGapMs: 5 * 60_000,
});

function isRoborockCloudHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return ["roborock.com", "roborock.cn", "roborock.net"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

function isCustomEndpoint(value, protocols) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      protocols.includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !isRoborockCloudHost(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * A custom login URL alone does not prove where requests go: an old cloud
 * token can still advertise Roborock's REST/MQTT endpoints. Require both
 * authenticated routes as well. No session yet means ordinary cadence.
 */
function resolveRequestPolicy(config = {}, session) {
  if (config.enableLocalServerFastRefresh !== true) {
    return DEFAULT_REQUEST_POLICY;
  }
  try {
    const server = parseServerURL(config.serverURL);
    const routes = session?.rriot?.r;
    if (
      isCustomEndpoint(server, ["https:"]) &&
      isCustomEndpoint(routes?.a, ["https:"]) &&
      isCustomEndpoint(routes?.m, ["ssl:", "mqtts:"])
    ) {
      return LOCAL_SERVER_REQUEST_POLICY;
    }
  } catch {
    // The normal login path reports a bad server URL; never accelerate it.
  }
  return DEFAULT_REQUEST_POLICY;
}

module.exports = {
  DEFAULT_REQUEST_POLICY,
  LOCAL_SERVER_REQUEST_POLICY,
  resolveRequestPolicy,
};
