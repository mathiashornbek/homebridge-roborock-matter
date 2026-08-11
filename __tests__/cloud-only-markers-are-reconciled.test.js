"use strict";

// Cloud-only mode overwrites part of a robot's transport diagnostics to say
// "local transport is switched off". Those diagnostics are PERSISTED, so the
// overwrite outlives the setting: turning cloud-only mode back off left
// `tcpConnectionState: "disabled"` on disk for good, because nothing rewrites
// that field until a LAN connection is actually attempted, and no connection
// is attempted for a robot the plugin never discovered a local IP for. The
// diagnostic report then read the stale marker back and told the user
// "Cloud-only mode is enabled, so local LAN discovery and local TCP control
// are disabled" two lines under its own `cloudOnlyMode: disabled` line — a
// report contradicting itself, and pointing at a setting that was off.
//
// The rule is enumerated over the marker table rather than over the three
// field names that happen to be in it today: a hand-written list of fields to
// clear is the same mistake as a hand-written list of files or log lines, one
// level down. A marker added to the table tomorrow is cleared tomorrow.

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  Roborock,
  CLOUD_ONLY_TRANSPORT_MARKERS,
} = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock(options = {}) {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-markers-")),
    ...options,
  });
}

const MARKER_FIELDS = Object.keys(CLOUD_ONLY_TRANSPORT_MARKERS);

describe("cloud-only transport markers follow the setting", () => {
  test("the marker table is not empty", () => {
    // Guards the tests below from passing vacuously if the table is emptied.
    expect(MARKER_FIELDS.length).toBeGreaterThan(0);
  });

  test("enabling cloud-only mode writes every marker in the table", async () => {
    const api = createRoborock();

    await api.syncCloudOnlyTransportMarkers("device-1", true);

    const entry = api.getTransportDiagnostics()["device-1"];
    for (const [field, value] of Object.entries(CLOUD_ONLY_TRANSPORT_MARKERS)) {
      expect(entry[field]).toBe(value);
    }
  });

  test("switching cloud-only mode off clears every marker the mode wrote", async () => {
    const api = createRoborock();

    await api.syncCloudOnlyTransportMarkers("device-1", true);
    await api.syncCloudOnlyTransportMarkers("device-1", false);

    const entry = api.getTransportDiagnostics()["device-1"];
    for (const field of MARKER_FIELDS) {
      expect(entry[field]).toBeNull();
    }
  });

  test("a robot that never ran in cloud-only mode is left alone", async () => {
    const api = createRoborock();
    await api.updateTransportDiagnostics("device-1", {
      tcpConnectionState: "connected",
      localDiscoveryState: "discovered",
      lastTransportReason: "local-request",
      localIp: "192.168.1.20",
    });

    await api.syncCloudOnlyTransportMarkers("device-1", false);

    const entry = api.getTransportDiagnostics()["device-1"];
    expect(entry.tcpConnectionState).toBe("connected");
    expect(entry.localDiscoveryState).toBe("discovered");
    expect(entry.lastTransportReason).toBe("local-request");
    expect(entry.localIp).toBe("192.168.1.20");
  });

  test("clearing only touches fields still holding the marker value", async () => {
    const api = createRoborock();

    await api.syncCloudOnlyTransportMarkers("device-1", true);
    // A real LAN connection came up while the markers were still on disk.
    await api.updateTransportDiagnostics("device-1", {
      tcpConnectionState: "connected",
    });

    await api.syncCloudOnlyTransportMarkers("device-1", false);

    const entry = api.getTransportDiagnostics()["device-1"];
    expect(entry.tcpConnectionState).toBe("connected");
    expect(entry.localDiscoveryState).toBeNull();
  });

  test("reconciling a robot with no diagnostics at all writes nothing", async () => {
    const api = createRoborock();

    await api.syncCloudOnlyTransportMarkers("unknown-device", false);

    expect(api.getTransportDiagnostics()).toEqual({});
  });
});

describe("the report cannot label a robot cloud-only once the markers are gone", () => {
  // The report infers "Cloud only" from exactly these persisted fields, so the
  // inference is only sound while the fields track the setting. This pins the
  // two halves together: whatever the marker table holds is what the branch
  // keys off. (The branch itself moved out of the TypeScript UI server into
  // roborockLib/lib/connectionState.js, so the suite — which runs before any
  // build — can exercise its wording rather than only grep for it.)
  const uiSource = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "lib", "connectionState.js"),
    "utf8"
  );
  // Just the `if (...)` condition that decides the "Cloud only" label.
  const conditionStart = uiSource.indexOf(
    'lastTransportReason === "cloud-only-mode"'
  );
  const condition = uiSource.slice(
    conditionStart,
    uiSource.indexOf("return {", conditionStart)
  );

  test("the cloud-only label keys off nothing but reconciled markers", () => {
    expect(conditionStart).toBeGreaterThan(-1);

    // `tcpState` is the local alias for transport.tcpConnectionState.
    const keyed = new Set(
      [
        ...condition.matchAll(/(?:safeT|t)ransport\.([A-Za-z]+)|\btcpState\b/g),
      ].map((match) => match[1] || "tcpConnectionState")
    );

    expect(keyed.size).toBeGreaterThan(0);
    // A field the branch reads but cloud-only mode does not own would never be
    // reconciled, and the stale label would come straight back.
    for (const field of keyed) {
      expect(MARKER_FIELDS).toContain(field);
    }
  });
});
