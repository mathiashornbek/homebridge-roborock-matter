"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

const platformSource = read("src", "platform.ts");
const apiSource = read("roborockLib", "roborockAPI.js");
const vacuumSource = read("roborockLib", "lib", "vacuum.js");
const uiSource = read("src", "ui", "index.ts");

function branchBetween(startMarker, endMarker) {
  const start = vacuumSource.indexOf(startMarker);
  const end = vacuumSource.indexOf(endMarker, start + startMarker.length);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return vacuumSource.slice(start, end);
}

describe("generic timer poll ownership", () => {
  test("the generic poll names both timer diagnostics", () => {
    expect(apiSource).toContain(
      'await this.pollParameter(duid, vacuum, "get_server_timer", isB01);'
    );
    expect(apiSource).toContain(
      'await this.pollParameter(duid, vacuum, "get_timer", isB01);'
    );
  });

  test("neither generic timer diagnostic sends outside explicit debug mode", () => {
    expect(platformSource).toMatch(
      /const debugMode = this\.platformConfig\.debugMode;[\s\S]*?new Roborock\(\{[\s\S]*?debug: debugMode,/
    );

    const serverTimerBranch = branchBetween(
      '} else if (parameter == "get_server_timer") {',
      '} else if (parameter == "get_timer") {'
    );
    const legacyTimerBranch = branchBetween(
      '} else if (parameter == "get_timer") {',
      '} else if (parameter == "get_photo") {'
    );

    for (const branch of [serverTimerBranch, legacyTimerBranch]) {
      expect(branch).toContain("if (this.adapter.config.debug) {");
      expect(branch).toContain("await sendParameterRequest(parameter, []);");
    }
  });

  test("get_timer remains a distinct user-requested diagnostic", () => {
    expect(vacuumSource).toContain(
      'await this.updateDiagnosticSnapshot(duid, "lastTimer", {'
    );
    expect(uiSource).toContain(
      "lastTimerDiagnostic: roborockDiagnostic.lastTimer || null"
    );
  });

  /**
   * Issue #22: the cloud schedule probe rides along on the legacy timer
   * diagnostic, which is the one point in a poll where both device-side timer
   * methods have already answered. Riding on a live poll is only acceptable
   * while the two properties below hold, and both are invisible in the probe's
   * own unit tests — they are properties of the CALL SITE.
   */
  test("the cloud schedule probe rides inside the debug-gated timer branch", () => {
    const legacyTimerBranch = branchBetween(
      '} else if (parameter == "get_timer") {',
      '} else if (parameter == "get_photo") {'
    );

    expect(legacyTimerBranch).toContain(
      "await this.adapter.probeCloudScheduleRoutes?.(duid);"
    );
    // The debug gate opens the branch, so the probe inherits it rather than
    // re-deciding for itself here.
    expect(
      legacyTimerBranch.indexOf("if (this.adapter.config.debug) {")
    ).toBeLessThan(legacyTimerBranch.indexOf("probeCloudScheduleRoutes"));
  });

  test("the probe cannot fail the poll it rides on", () => {
    const legacyTimerBranch = branchBetween(
      '} else if (parameter == "get_timer") {',
      '} else if (parameter == "get_photo") {'
    );

    expect(legacyTimerBranch).toMatch(
      /try \{\s*await this\.adapter\.probeCloudScheduleRoutes\?\.\(duid\);\s*\} catch \(error\) \{/
    );
  });

  test("the probe reads the cloud schedule routes and only reads", () => {
    expect(apiSource).toContain("`user/devices/${duid}/jobs`");
    expect(apiSource).toContain("`user/scene/device/${duid}`");
    // The singular scene resource, read to find out whether a schedule is
    // something the plugin could ever write to. See 3.25.0.
    expect(apiSource).toContain("`user/scene/${firstSchedule.id}`");

    // The window spans BOTH probe methods: the per-route reader and the
    // orchestrator that calls it. Reading only one of them would let a write
    // move into the other and still pass.
    const probeStart = apiSource.indexOf("async probeOneCloudScheduleRoute(");
    const probeEnd = apiSource.indexOf("async updateServerTimer(", probeStart);
    expect(probeStart).toBeGreaterThanOrEqual(0);
    expect(probeEnd).toBeGreaterThan(probeStart);

    const probeSource = apiSource.slice(probeStart, probeEnd);
    expect(probeSource).toContain("async probeCloudScheduleRoutes(");
    expect(probeSource).toContain("await this.api.get(route.path)");
    // A write to any of these routes would change a user's schedule. The probe
    // exists to measure, and nothing in it may send one.
    expect(probeSource).not.toMatch(/this\.api\.(post|put|patch|delete)\(/);
  });
});
