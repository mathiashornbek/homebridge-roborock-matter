const { Roborock } = require("../roborockLib/roborockAPI");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deviceFeatures } = require("../roborockLib/lib/deviceFeatures");

// `dock_type: 20` arrived in a diagnostics export from an a185 (Qrevo CurvX)
// owner in issue #6 — the first dock code this project had ever seen outside
// the inherited table, which stops at 9. Upstream python-roborock calls 20
// `k1s_dock` and knows a further dozen codes (10, 11, 13-24, 26) that this
// project has no report for.
//
// The number alone did not earn the capability. Issue #10 is why: upstream
// declared a Max+ suction level for the a104 that the robot does not have, and
// building on the table would have offered every Qrevo S owner a level their
// robot lacks. So 20 was held back until its owner answered the one question
// that settles it — "does the dock empty the robot's bin?" — and on
// 23 August 2026 he did: "Yes the CurvX auto empties into the dock."
//
// These tests pin that report, and pin the rule it came from: a dock code is
// in the auto-empty set because an owner said so, never because a table did.

const FIELD_REPORTED_AUTO_EMPTY_DOCK_TYPE = 20;

// Codes upstream python-roborock names but no owner has reported to this
// project. They must stay out of the auto-empty set until one does.
const UPSTREAM_KNOWN_BUT_UNREPORTED_DOCK_TYPES = [
  10, 11, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 26,
];

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
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-dock-test-")),
    ...options,
  });
}

function createFeatures(dockType) {
  const adapter = {
    config: { hostname_ip: "127.0.0.1" },
    translations: {},
    log: createLog(),
    getVacuumDeviceInfo: jest.fn(() => "1.0"),
    getProductAttribute: jest.fn(() => "roborock.vacuum.a185"),
  };

  return new deviceFeatures(adapter, 0, "0", `dock-${dockType}`);
}

function installsAutoEmptyCommand(dockType) {
  const features = createFeatures(dockType);
  features.processDockType(dockType);

  return typeof features.commands.app_start_collect_dust !== "undefined";
}

function apiReportsDustCollection(dockType) {
  const api = createRoborock();
  api.hasVacuumFeature = jest.fn(() => false);
  api.getVacuumDeviceStatus = jest.fn(() => dockType);

  return api.supportsDustCollection("device-1");
}

describe("a new dock type enters the auto-empty set on an owner's report", () => {
  test("the a185 owner's dock_type 20 offers the Empty Bin switch", () => {
    expect(apiReportsDustCollection(FIELD_REPORTED_AUTO_EMPTY_DOCK_TYPE)).toBe(
      true
    );
  });

  test("dock_type 20 installs the auto-empty command on the command table", () => {
    expect(installsAutoEmptyCommand(FIELD_REPORTED_AUTO_EMPTY_DOCK_TYPE)).toBe(
      true
    );
  });

  test("dock_type 20 is named, so a log line does not call the CurvX dock unknown", () => {
    const features = createFeatures(FIELD_REPORTED_AUTO_EMPTY_DOCK_TYPE);
    const dockTypeNames = features.deviceStates.dock_type.states;

    expect(dockTypeNames[FIELD_REPORTED_AUTO_EMPTY_DOCK_TYPE]).toBeTruthy();
  });

  // The rule, not the case: the two sides of this decision live in different
  // files (`roborockAPI.js` decides the switch, `deviceFeatures.js` installs
  // the command) and a code added to one but not the other is the defect this
  // catches. The existing sibling test in roborockAPI.test.js enumerates 0-9;
  // this one runs the full range upstream names, so the next code someone adds
  // in one place only fails here.
  test("every dock code agrees across the API and the command table", () => {
    const commandDockTypes = [];
    const apiDockTypes = [];

    for (let dockType = 0; dockType <= 26; dockType += 1) {
      if (installsAutoEmptyCommand(dockType)) {
        commandDockTypes.push(dockType);
      }
      if (apiReportsDustCollection(dockType)) {
        apiDockTypes.push(dockType);
      }
    }

    expect(apiDockTypes).toEqual(commandDockTypes);
    expect(apiDockTypes).toContain(FIELD_REPORTED_AUTO_EMPTY_DOCK_TYPE);
  });

  // Issue #10's lesson, pinned so nobody bulk-imports the upstream table.
  test.each(UPSTREAM_KNOWN_BUT_UNREPORTED_DOCK_TYPES)(
    "dock_type %i stays out of the auto-empty set until an owner reports it",
    (dockType) => {
      expect(apiReportsDustCollection(dockType)).toBe(false);
      expect(installsAutoEmptyCommand(dockType)).toBe(false);
    }
  );

  test("a robot feature still grants dust collection on an unreported dock", () => {
    const api = createRoborock();
    api.getVacuumDeviceStatus = jest.fn(() => 21);
    api.hasVacuumFeature = jest.fn(() => true);

    expect(api.supportsDustCollection("device-1")).toBe(true);
  });
});
