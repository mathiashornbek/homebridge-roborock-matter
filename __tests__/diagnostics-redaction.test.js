"use strict";

// The diagnostics report exists to be pasted into public GitHub issues, so the
// raw robot RPC block it carries has to be redacted by an allowlist-shaped
// rule rather than a denylist of a few key names. get_network_info answers
// with the home Wi-Fi SSID, the access point BSSID and the robot MAC — none of
// which matched the upstream token|key|password filter, and a BSSID resolves
// to a street address in public Wi-Fi geolocation databases.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/** Load the two pure helpers out of the browser bundle without a DOM. */
function loadHelpers() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "homebridge-ui", "public", "index.js"),
    "utf8"
  );
  const start = source.indexOf("const SENSITIVE_DIAGNOSTIC_KEY_PATTERN");
  const end = source.indexOf("function appendLocalTestReport");
  const context = {
    maskLocalIpsInText: (text) =>
      text.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, "$1.x"),
    module: {},
  };
  vm.createContext(context);
  vm.runInContext(
    source.slice(start, end) +
      "\nmodule.exports = { formatDiagnosticPayload, redactDiagnosticValue };",
    context
  );
  return context.module.exports;
}

const { formatDiagnosticPayload, redactDiagnosticValue } = loadHelpers();

describe("diagnostic payload redaction", () => {
  const networkInfo = {
    source: "CloudMessage",
    payload: {
      bssid: "aa:bb:cc:dd:ee:ff",
      ssid: "Hornbek Home 5G",
      mac: "11:22:33:44:55:66",
      ip: "192.168.5.42",
      rssi: -52,
      gw: "192.168.5.1",
    },
  };

  test("Wi-Fi identifiers never reach the copyable report", () => {
    const text = formatDiagnosticPayload(networkInfo);

    expect(text).not.toContain("Hornbek Home 5G");
    expect(text).not.toContain("aa:bb:cc:dd:ee:ff");
    expect(text).not.toContain("11:22:33:44:55:66");
  });

  test("the local IP is still octet-masked", () => {
    expect(formatDiagnosticPayload(networkInfo)).toContain("192.168.5.x");
  });

  test("diagnostically useful values survive", () => {
    const text = formatDiagnosticPayload(networkInfo);
    expect(text).toContain("rssi");
    expect(text).toContain("-52");
  });

  test("nested payloads are redacted too", () => {
    const redacted = redactDiagnosticValue({
      a: [{ b: { ssid: "secret-net", state: 5 } }],
    });
    expect(redacted.a[0].b.ssid).toBe("[redacted]");
    expect(redacted.a[0].b.state).toBe(5);
  });

  test("a real status payload is left readable", () => {
    const status = {
      method: "get_status",
      status: { state: 26, battery: 42, fan_power: 110, water_box_mode: 209 },
    };
    const text = formatDiagnosticPayload(status);
    expect(text).toContain("get_status");
    expect(text).toContain("110");
    expect(text).toContain("209");
  });

  test("deeply nested input cannot recurse without bound", () => {
    let deep = { state: 1 };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => redactDiagnosticValue(deep)).not.toThrow();
  });
});
