"use strict";

// A robot can end up routed over the Roborock cloud for reasons that have
// nothing to do with each other:
//
//   * a B01/Q7 robot is marked remote at startup because its protocol has no
//     LAN request surface, so no local connection is ever attempted;
//   * any other robot is marked remote only after a local TCP connect has
//     genuinely been tried and failed.
//
// Membership of `remoteDevices` records that a robot is remote. It cannot
// record why. The report used to assume the second reason for every member,
// which meant a Q7 owner's diagnostics stated that a local connection had been
// attempted and had failed — for a robot the plugin deliberately never opens a
// local connection to. He unpaired from Apple Home, uninstalled the plugin,
// reinstalled it and paired fresh, chasing a LAN fault that could not exist
// (#7). The report's own maintainer read the same line and drew the same wrong
// conclusion, which is the tell that this was a defect and not a wording nit.
//
// The rule is enumerated over the source tree rather than over the two call
// sites that exist today: any future code path that marks a robot remote has
// to say why, and a path that forgets degrades to the vague "remote-device"
// instead of inventing a specific cause. A hand-written list of call sites is
// the same mistake as a hand-written list of files or log lines.

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  Roborock,
  UNEXPLAINED_REMOTE_REASON,
} = require("../roborockLib/roborockAPI");
const {
  B01_CLOUD_ONLY_REMOTE_REASON,
} = require("../roborockLib/lib/b01Q7Adapter");
const {
  describeConnectionState,
  describeLocalProbeSkip,
  isCloudFallbackLikely,
} = require("../roborockLib/lib/connectionState");
const { localConnector } = require("../roborockLib/lib/localConnector");

const CONNECT_FAILURE_REASON = "marked-remote-after-connect-failure";
const REPO_ROOT = path.join(__dirname, "..");
const SOURCE_ROOTS = ["roborockLib", "src", "homebridge-ui"];
const SOURCE_EXTENSIONS = [".js", ".ts"];

function collectSourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      collectSourceFiles(fullPath, found);
      continue;
    }

    if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      found.push(fullPath);
    }
  }

  return found;
}

function sourceFiles() {
  const files = [path.join(REPO_ROOT, "index.js")].filter((file) =>
    fs.existsSync(file)
  );

  for (const root of SOURCE_ROOTS) {
    const dir = path.join(REPO_ROOT, root);
    if (fs.existsSync(dir)) {
      collectSourceFiles(dir, files);
    }
  }

  return files;
}

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock() {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-remote-")),
  });
}

async function seedHomeData(api, duid) {
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      devices: [{ duid, name: "Robo", online: true }],
      receivedDevices: [],
      products: [],
    }),
    ack: true,
  });
}

describe("every remote marking carries its own reason", () => {
  test("no source file marks a robot remote behind the helpers' backs", () => {
    const files = sourceFiles();
    // Guards against the walker silently finding nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(10);

    const apiPath = path.join(REPO_ROOT, "roborockLib", "roborockAPI.js");
    const offenders = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const mutations = [
        ...source.matchAll(/remoteDevices\s*\.\s*(add|delete)/g),
      ];

      if (file === apiPath) {
        // The helpers own the set; every mutation must sit inside one of them.
        for (const match of mutations) {
          const enclosing = source.lastIndexOf("\n  ", match.index);
          const methodStart = source.lastIndexOf(
            "\n  async markDeviceRemote(",
            match.index
          );
          const clearStart = source.lastIndexOf(
            "\n  clearRemoteDevice(",
            match.index
          );
          const nearestHelper = Math.max(methodStart, clearStart);
          const nearestHelperEnd =
            nearestHelper === -1 ? -1 : source.indexOf("\n  }", nearestHelper);

          const insideHelper =
            nearestHelper !== -1 &&
            match.index > nearestHelper &&
            match.index < nearestHelperEnd;

          if (!insideHelper) {
            offenders.push(
              `${path.relative(REPO_ROOT, file)}: ${source.slice(enclosing, match.index + 40).trim()}`
            );
          }
        }
        continue;
      }

      for (const match of mutations) {
        offenders.push(
          `${path.relative(REPO_ROOT, file)}: ${match[0]} — use markDeviceRemote(duid, reason) / clearRemoteDevice(duid)`
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  test("a B01 robot reports its protocol, not a failed LAN connection", async () => {
    const api = createRoborock();
    await seedHomeData(api, "device-b01");

    await api.markDeviceRemote("device-b01", B01_CLOUD_ONLY_REMOTE_REASON);
    await expect(api.isRemoteDevice("device-b01")).resolves.toBe(true);

    const entry = api.getTransportDiagnostics()["device-b01"];
    expect(entry.isRemote).toBe(true);
    expect(entry.remoteReason).toBe(B01_CLOUD_ONLY_REMOTE_REASON);
    expect(entry.remoteReason).not.toBe(CONNECT_FAILURE_REASON);
  });

  test("a failed local TCP connect still reports exactly that", async () => {
    const api = createRoborock();
    await seedHomeData(api, "device-lan");

    await api.markDeviceRemote("device-lan", CONNECT_FAILURE_REASON);
    await expect(api.isRemoteDevice("device-lan")).resolves.toBe(true);

    expect(api.getTransportDiagnostics()["device-lan"].remoteReason).toBe(
      CONNECT_FAILURE_REASON
    );
  });

  test("a marking with no reason stays vague instead of guessing", async () => {
    const api = createRoborock();
    await seedHomeData(api, "device-mystery");

    // A future call site that forgets its reason, or a marker restored from an
    // older release. The report may say nothing useful; it may not invent a
    // cause the user will act on.
    api.remoteDevices.add("device-mystery");
    await expect(api.isRemoteDevice("device-mystery")).resolves.toBe(true);

    const reason = api.getTransportDiagnostics()["device-mystery"].remoteReason;
    expect(reason).toBe(UNEXPLAINED_REMOTE_REASON);
    expect(reason).not.toBe(CONNECT_FAILURE_REASON);
  });

  test("clearing a remote marking drops its reason too", async () => {
    const api = createRoborock();

    await api.markDeviceRemote("device-b01", B01_CLOUD_ONLY_REMOTE_REASON);
    expect(api.clearRemoteDevice("device-b01")).toBe(true);
    expect(api.remoteDevices.has("device-b01")).toBe(false);
    expect(api.getRemoteDeviceReason("device-b01")).toBe(
      UNEXPLAINED_REMOTE_REASON
    );
  });

  test("the local connector records the reason it actually observed", async () => {
    const markDeviceRemote = jest.fn().mockResolvedValue(undefined);
    const adapter = {
      log: createLog(),
      remoteDevices: new Set(),
      remoteDeviceReasons: new Map(),
      markDeviceRemote,
      clearRemoteDevice: jest.fn().mockReturnValue(false),
      onlineChecker: jest.fn().mockResolvedValue(true),
      updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
      localKeys: new Map([["device-lan", "local-key"]]),
      localL01Nonces: new Map(),
      pendingRequests: new Map(),
      catchError: jest.fn(),
      getRobotVersion: jest.fn().mockResolvedValue("1.0"),
      message: { _decodeMsg: jest.fn(), buildRoborockMessage: jest.fn() },
    };
    const connector = new localConnector(adapter);

    // Nothing is listening on the local control port here, so the connect is
    // refused — the one path that is genuinely allowed to blame the LAN.
    await connector.createClient("device-lan", "127.0.0.1");

    expect(markDeviceRemote).toHaveBeenCalledWith(
      "device-lan",
      CONNECT_FAILURE_REASON
    );

    connector.resetClient("device-lan").catch(() => {});
  });

  test("every reason a robot can be marked with renders as English", () => {
    const api = createRoborock();

    for (const reason of [
      B01_CLOUD_ONLY_REMOTE_REASON,
      CONNECT_FAILURE_REASON,
      UNEXPLAINED_REMOTE_REASON,
    ]) {
      const rendered = api.describeTransportReason(reason);
      // A slug that falls through the table reaches the user verbatim.
      expect(rendered).not.toBe(reason);
      expect(rendered.length).toBeGreaterThan(0);
    }

    // The distinction the whole fix exists for: the B01 explanation must not
    // describe a connection attempt.
    expect(
      api.describeTransportReason(B01_CLOUD_ONLY_REMOTE_REASON)
    ).not.toMatch(/failed/i);
  });
});

describe("the report describes a B01 robot truthfully", () => {
  const b01Transport = {
    remoteReason: B01_CLOUD_ONLY_REMOTE_REASON,
    isRemote: true,
    lastTransport: "cloud",
    lastTransportReason: "remote-device",
    localIp: null,
    localDiscoveryState: "not-discovered",
    tcpConnectionState: null,
  };

  test("the device card does not call the only transport a fallback", () => {
    const state = describeConnectionState({ online: true }, b01Transport, true);

    expect(state.status).not.toBe("Cloud fallback");
    expect(state.health).toBe("good");
    expect(state.hint).not.toMatch(/LAN TCP was not connected/i);
    expect(state.hint).toMatch(/cloud protocol/i);
  });

  test("a robot on a LAN-capable model is still called a fallback", () => {
    // The B01 branch must not swallow the case it sits in front of.
    const state = describeConnectionState(
      { online: true },
      { lastTransport: "cloud", remoteReason: CONNECT_FAILURE_REASON },
      true
    );

    expect(state.status).toBe("Cloud fallback");
    expect(state.health).toBe("warn");
  });

  test("an offline B01 robot is still reported offline", () => {
    // Being cloud-only explains the transport, not the silence.
    const state = describeConnectionState(
      { online: false },
      b01Transport,
      true
    );

    expect(state.status).toBe("Device offline");
  });

  test("the LAN test does not ask the user to wait for a discovery that never comes", () => {
    const skip = describeLocalProbeSkip({
      cloudOnlyProtocol: true,
      cloudOnlyMode: false,
      hasLocalKey: true,
      online: true,
      localIp: null,
    });

    expect(skip).not.toBeNull();
    expect(skip.health).toBe("good");
    expect(skip.message).not.toMatch(/cached yet/i);
    expect(skip.message).not.toMatch(/press Refresh/i);
  });

  test("a LAN-capable robot with no IP is still told to wait", () => {
    const skip = describeLocalProbeSkip({
      cloudOnlyProtocol: false,
      cloudOnlyMode: false,
      hasLocalKey: true,
      online: true,
      localIp: null,
    });

    expect(skip.message).toMatch(/No local IP address is cached yet/);
    expect(skip.health).toBe("warn");
  });

  test("a cloud-only protocol is not flagged as a likely cloud fallback", () => {
    expect(
      isCloudFallbackLikely({
        remoteReason: B01_CLOUD_ONLY_REMOTE_REASON,
        lastTransport: "cloud",
        connectionStatus: "Cloud control (this model)",
      })
    ).toBe(false);

    expect(
      isCloudFallbackLikely({
        remoteReason: CONNECT_FAILURE_REASON,
        lastTransport: "cloud",
        connectionStatus: "Cloud fallback",
      })
    ).toBe(true);
  });
});
